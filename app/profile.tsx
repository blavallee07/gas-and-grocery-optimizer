import { supabase } from '@/lib/supabase';
import { Picker } from '@react-native-picker/picker';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

const PROXY_BASE = 'http://localhost:3001/api';
// Temporarily use direct API access since proxy is having issues
const FUELECONOMY_BASE = 'https://www.fueleconomy.gov/ws/rest';

// Fallback list of common makes
const FALLBACK_MAKES = [
  'Acura', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler',
  'Dodge', 'Ford', 'Genesis', 'GMC', 'Honda', 'Hyundai', 'Infiniti',
  'Jeep', 'Kia', 'Lexus', 'Lincoln', 'Mazda', 'Mercedes-Benz', 'Mitsubishi',
  'Nissan', 'Ram', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'
];

export default function ProfileScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const initialLoadDone = useRef(false);
  const savedVehicleData = useRef<{make: string, model: string, trim: string}>({make: '', model: '', trim: ''});

  const [profile, setProfile] = useState<any>({
    vehicle_year: '',
    vehicle_make: '',
    vehicle_model: '',
    vehicle_trim: '',
    tank_size_l: '',
    fuel_efficiency: '',
    fuel_type: '',
    home_lat: '',
    home_lng: '',
    max_detour_km: '5.0',
    min_savings: '1.0',
    search_radius_km: '15.0',
  });

  const [years] = useState(() => {
    const now = new Date().getFullYear();
    const list: string[] = [];
    for (let y = now + 1; y >= 1980; y--) list.push(String(y));
    return list;
  });
  
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [trims, setTrims] = useState<{ value: string; text: string }[]>([]);
  const [selectedTrimId, setSelectedTrimId] = useState<string>('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [manualFuelMode, setManualFuelMode] = useState(false);
  const [makesLoading, setMakesLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [addressSuggestions, setAddressSuggestions] = useState<{ label: string; lat: number; lon: number }[]>([]);
  const addressDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const makesCache = useRef<Record<string, string[]>>({});
  const modelsCache = useRef<Record<string, string[]>>({});

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          console.error('Session error:', sessionError);
          throw new Error('Authentication error. Please log in again.');
        }
        
        const user = session?.user;
        if (!user) {
          console.log('No user session, redirecting to login');
          router.replace('/login');
          return;
        }

        console.log('Loading profile for user:', user.id);
        const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
        
        if (error) {
          console.error('Supabase fetch error:', error);
          throw new Error(`Database error: ${error.message}`);
        }
        
        if (!mounted) return;

        if (data) {
          savedVehicleData.current = {
            make: data.vehicle_make ?? '',
            model: data.vehicle_model ?? '',
            trim: data.vehicle_trim ?? '',
          };

          setProfile({
            vehicle_year: data.vehicle_year?.toString() ?? '',
            vehicle_make: data.vehicle_make ?? '',
            vehicle_model: data.vehicle_model ?? '',
            vehicle_trim: data.vehicle_trim ?? '',
            tank_size_l: data.tank_size_l?.toString() ?? '',
            fuel_efficiency: data.fuel_efficiency?.toString() ?? '',
            fuel_type: data.fuel_type ?? '',
            home_lat: data.home_lat?.toString() ?? '',
            home_lng: data.home_lng?.toString() ?? '',
            max_detour_km: data.max_detour_km?.toString() ?? '5.0',
            min_savings: data.min_savings?.toString() ?? '1.0',
            search_radius_km: data.search_radius_km?.toString() ?? '15.0',
          });

          // Reverse geocode saved coordinates so the address field isn't blank
          if (data.home_lat && data.home_lng) {
            fetch(`https://photon.komoot.io/reverse?lat=${data.home_lat}&lon=${data.home_lng}&limit=1`)
              .then(r => r.json())
              .then(d => {
                const p = d.features?.[0]?.properties || {};
                const parts = [p.name || p.street, p.city || p.town || p.village, p.state].filter(Boolean);
                if (parts.length && mounted) setAddressInput(parts.join(', '));
              })
              .catch(() => {});
          }
        }
      } catch (e: any) {
        console.error('Load profile error:', e);
        // Don't block the UI - let user create new profile even if load fails
        if (e.message?.includes('Authentication') || e.message?.includes('log in')) {
          Alert.alert('Session Expired', 'Please log in again.', [
            { text: 'OK', onPress: () => router.replace('/login') }
          ]);
        } else {
          Alert.alert(
            'Load Error', 
            'Could not load existing profile. You can still create a new one.\n\n' + (e.message || 'Unknown error'),
            [{ text: 'OK' }]
          );
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [router]);

  useEffect(() => {
    const year = profile.vehicle_year;
    if (!year) return;

    let mounted = true;
    (async () => {
      setMakesLoading(true);
      setApiError(null);
      try {
        let makesList: string[];
        if (makesCache.current[year]) {
          makesList = makesCache.current[year];
        } else {
          const res = await fetch(`${FUELECONOMY_BASE}/vehicle/menu/make?year=${year}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          const text = await res.text();
          if (!mounted) return;
          console.log('Makes API response:', text.substring(0, 500));
          const matches = [...text.matchAll(/<text>([^<]+)<\/text>/g)];
          const list = matches.map(m => m[1]).filter(Boolean);
          makesList = list.length > 0 ? [...new Set(list)].sort() : FALLBACK_MAKES;
          console.log('Parsed makes:', makesList.length, makesList.slice(0, 5));
          makesCache.current[year] = makesList;
        }
        setMakes(makesList);

        // Only clear downstream values when the user actively changes the year
        if (initialLoadDone.current) {
          setModels([]);
          setTrims([]);
          setProfile((p: any) => ({ ...p, vehicle_make: '', vehicle_model: '', vehicle_trim: '' }));
        }
      } catch (e: any) {
        console.error('Failed to load makes', e);
        const errorMsg = e.message || 'Network error';
        setApiError(`Unable to load vehicle makes from API. Using fallback list.`);
        // Use fallback makes if API fails
        setMakes(FALLBACK_MAKES);
      } finally {
        if (mounted) setMakesLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [profile.vehicle_year]);

  useEffect(() => {
    const year = profile.vehicle_year;
    const make = profile.vehicle_make;
    if (!year || !make) return;

    let mounted = true;
    (async () => {
      setModelsLoading(true);
      try {
        const cacheKey = `${year}|${make}`;
        let modelsList: string[];
        if (modelsCache.current[cacheKey]) {
          modelsList = modelsCache.current[cacheKey];
        } else {
          const res = await fetch(`${FUELECONOMY_BASE}/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}`);
          const text = await res.text();
          if (!mounted) return;
          console.log('Models API response:', text.substring(0, 500));
          const matches = [...text.matchAll(/<text>([^<]+)<\/text>/g)];
          const list = matches.map(m => m[1]).filter(Boolean);
          modelsList = [...new Set(list)].sort();
          console.log('Parsed models:', modelsList.length, modelsList.slice(0, 5));
          modelsCache.current[cacheKey] = modelsList;
        }
        setModels(modelsList);

        if (!initialLoadDone.current) {
          initialLoadDone.current = true;
        } else {
          // User actively changed the make — clear downstream
          setTrims([]);
          setProfile((p: any) => ({ ...p, vehicle_model: '', vehicle_trim: '' }));
        }
      } catch (e: any) {
        console.error('Failed to load models', e);
        const errorMsg = e.message || 'Network error';
        setApiError(`Unable to load vehicle models: ${errorMsg}`);
        setModels([]);
      } finally {
        if (mounted) setModelsLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [profile.vehicle_make, profile.vehicle_year]);

  useEffect(() => {
    const year = profile.vehicle_year;
    const make = profile.vehicle_make;
    const model = profile.vehicle_model;
    if (!year || !make || !model) return;

    let mounted = true;
    (async () => {
      try {
        const optsRes = await fetch(`${FUELECONOMY_BASE}/vehicle/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`);
        const optsText = await optsRes.text();
        if (!mounted) return;
        
        const itemRegex = /<menuItem>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<value>(\d+)<\/value>[\s\S]*?<\/menuItem>/g;
        const found: { value: string; text: string }[] = [];
        let m;
        while ((m = itemRegex.exec(optsText)) !== null) {
          found.push({ text: m[1], value: m[2] });
        }
        
        if (found.length > 0) {
          setTrims(found);
          
          if (!initialLoadDone.current && savedVehicleData.current.trim) {
            const matchingTrim = found.find(t => t.text === savedVehicleData.current.trim);
            if (matchingTrim) {
              setSelectedTrimId(matchingTrim.value);
              setProfile((p: any) => ({ ...p, vehicle_trim: matchingTrim.text }));
            }
          } else if (found.length === 1) {
            setSelectedTrimId(found[0].value);
            setProfile((p: any) => ({ ...p, vehicle_trim: found[0].text }));
          } else {
            setSelectedTrimId('');
          }
          return;
        }

        const menuRes = await fetch(`${FUELECONOMY_BASE}/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`);
        const menuText = await menuRes.text();
        const idMatch = menuText.match(/<value>(\d+)<\/value>/);
        if (!idMatch) return;
        
        const vid = idMatch[1];
        const vehRes = await fetch(`${FUELECONOMY_BASE}/vehicle/${vid}`);
        const vehText = await vehRes.text();
        const combMatch = vehText.match(/<comb08>([0-9.]+)<\/comb08>/);
        const fuelTypeMatch = vehText.match(/<fuelType>([^<]+)<\/fuelType>/);
        if (!mounted) return;
        
        if (combMatch) {
          const mpg = parseFloat(combMatch[1]);
          const lPer100km = +(235.214583 / mpg).toFixed(2);
          setProfile((p: any) => ({ ...p, fuel_efficiency: String(lPer100km) }));
          setLookupError(null);
        }
        if (fuelTypeMatch) {
          setProfile((p: any) => ({ ...p, fuel_type: fuelTypeMatch[1] }));
        }
      } catch (e: any) {
        console.error('Failed to lookup fuel economy', e);
        const errorMsg = e.message || 'Network error';
        setLookupError(errorMsg);
        setManualFuelMode(true);
      }
    })();

    return () => { mounted = false; };
  }, [profile.vehicle_model]);

  useEffect(() => {
    const vid = selectedTrimId;
    if (!vid) return;
    
    let mounted = true;
    (async () => {
      try {
        const vehRes = await fetch(`${FUELECONOMY_BASE}/vehicle/${vid}`);
        const vehText = await vehRes.text();
        const combMatch = vehText.match(/<comb08>([0-9.]+)<\/comb08>/);
        const fuelTypeMatch = vehText.match(/<fuelType>([^<]+)<\/fuelType>/);
        if (!mounted) return;
        
        if (combMatch) {
          const mpg = parseFloat(combMatch[1]);
          const lPer100km = +(235.214583 / mpg).toFixed(2);
          setProfile((p: any) => ({ ...p, fuel_efficiency: String(lPer100km) }));
          setLookupError(null);
          setManualFuelMode(false);
        }
        if (fuelTypeMatch) {
          setProfile((p: any) => ({ ...p, fuel_type: fuelTypeMatch[1] }));
        }
      } catch (e: any) {
        console.error('Failed to fetch vehicle details', e);
        const errorMsg = e.message || 'Network error';
        setLookupError(errorMsg);
        setManualFuelMode(true);
      }
    })();

    return () => { mounted = false; };
  }, [selectedTrimId]);

  const save = async () => {
    if (saving) return;
    
    setSaving(true);
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      
      if (!user) {
        setSaving(false);
        Alert.alert('Session Expired', 'Please log in again.');
        router.replace('/login');
        return;
      }

      const payload = {
        id: user.id,
        vehicle_year: profile.vehicle_year ? parseInt(profile.vehicle_year, 10) : null,
        vehicle_make: profile.vehicle_make || null,
        vehicle_model: profile.vehicle_model || null,
        vehicle_trim: profile.vehicle_trim || null,
        tank_size_l: profile.tank_size_l ? parseFloat(profile.tank_size_l) : null,
        fuel_efficiency: profile.fuel_efficiency ? parseFloat(profile.fuel_efficiency) : null,
        fuel_type: profile.fuel_type || null,
        home_lat: profile.home_lat ? parseFloat(profile.home_lat) : null,
        home_lng: profile.home_lng ? parseFloat(profile.home_lng) : null,
        max_detour_km: profile.max_detour_km ? parseFloat(profile.max_detour_km) : 5.0,
        min_savings: profile.min_savings ? parseFloat(profile.min_savings) : 1.0,
        search_radius_km: profile.search_radius_km ? parseFloat(profile.search_radius_km) : 15.0,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('profiles').upsert(payload);
      
      if (error) {
        setSaving(false);
        Alert.alert('Error', error.message || 'Failed to save profile');
        return;
      }
      
      setSaving(false);
      
      // Navigate back to home page to indicate successful save
      router.push('/(tabs)');
      
    } catch (error: any) {
      setSaving(false);
      console.error('Save error:', error);
      Alert.alert('Error', error.message || 'Failed to save profile');
    }
  };

  const getLocation = async () => {
    setLocationFailed(false);
    setLocationError(null);
    setLocationLoading(true);
    try {
      let latitude: number;
      let longitude: number;

      if (typeof window !== 'undefined' && window.navigator?.geolocation) {
        // Try browser geolocation first, fall back to IP-based
        const browserPos = await new Promise<{ latitude: number; longitude: number } | null>((resolve) => {
          window.navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 10000, enableHighAccuracy: true }
          );
        });

        if (browserPos) {
          latitude = browserPos.latitude;
          longitude = browserPos.longitude;
        } else {
          // IP geolocation fallback — no permissions required
          const res = await fetch('https://ipapi.co/json/');
          const data = await res.json();
          if (!data.latitude || !data.longitude) throw new Error('IP geolocation failed');
          latitude = data.latitude;
          longitude = data.longitude;
        }
      } else {
        // Native: use expo-location
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission denied', 'Location permission is required.');
          setLocationFailed(true);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
      }

      setProfile((p: any) => ({
        ...p,
        home_lat: String(latitude),
        home_lng: String(longitude),
      }));
    } catch (e: any) {
      console.error('Location error', e);
      setLocationFailed(true);
      setLocationError(`Failed to get location: ${e?.message || 'unknown error'}`);
    } finally {
      setLocationLoading(false);
    }
  };

  const onAddressChange = (text: string) => {
    setAddressInput(text);
    if (addressDebounce.current) clearTimeout(addressDebounce.current);
    if (!text.trim() || text.length < 3) {
      setAddressSuggestions([]);
      return;
    }
    addressDebounce.current = setTimeout(async () => {
      try {
        const encoded = encodeURIComponent(text.trim());
        const res = await fetch(`https://photon.komoot.io/api/?q=${encoded}&limit=5`);
        const data = await res.json();
        const suggestions = (data.features || []).map((f: any) => {
          const p = f.properties;
          const parts = [p.name, p.street, p.city || p.town || p.village, p.state].filter(Boolean);
          return {
            label: parts.join(', '),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
          };
        });
        setAddressSuggestions(suggestions);
      } catch {
        setAddressSuggestions([]);
      }
    }, 400);
  };

  const selectAddress = (item: { label: string; lat: number; lon: number }) => {
    setProfile((p: any) => ({
      ...p,
      home_lat: String(item.lat),
      home_lng: String(item.lon),
    }));
    setAddressInput(item.label);
    setAddressSuggestions([]);
    setLocationFailed(false);
    setLocationError(null);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4285F4" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Hero */}
        <View style={styles.hero}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backBtnText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.heroTitle}>Profile</Text>
          <Text style={styles.heroSub}>Vehicle, location & preferences</Text>
        </View>

        {apiError && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{apiError}</Text>
            <TouchableOpacity onPress={() => setApiError(null)}>
              <Text style={styles.bannerDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Vehicle */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vehicle</Text>

          <Field label="Year">
            <View style={styles.pickerWrap}>
              <Picker selectedValue={profile.vehicle_year} onValueChange={(v) => setProfile({ ...profile, vehicle_year: v })} style={styles.picker}>
                <Picker.Item label="Select year" value="" />
                {years.map((y) => <Picker.Item key={y} label={y} value={y} />)}
              </Picker>
            </View>
          </Field>

          <Field label="Make">
            <View style={styles.pickerWrap}>
              <Picker selectedValue={profile.vehicle_make} onValueChange={(v) => setProfile({ ...profile, vehicle_make: v })} enabled={!!profile.vehicle_year && !makesLoading} style={styles.picker}>
                <Picker.Item label={makesLoading ? 'Loading...' : 'Select make'} value="" />
                {makes.map((m) => <Picker.Item key={m} label={m} value={m} />)}
              </Picker>
            </View>
          </Field>

          <Field label="Model">
            <View style={styles.pickerWrap}>
              <Picker selectedValue={profile.vehicle_model} onValueChange={(v) => setProfile({ ...profile, vehicle_model: v })} enabled={!!profile.vehicle_make && !modelsLoading} style={styles.picker}>
                <Picker.Item label={modelsLoading ? 'Loading...' : 'Select model'} value="" />
                {models.map((m) => <Picker.Item key={m} label={m} value={m} />)}
              </Picker>
            </View>
          </Field>

          <Field label="Trim">
            {trims.length > 0 ? (
              <View style={styles.pickerWrap}>
                <Picker selectedValue={selectedTrimId} onValueChange={(v) => { setSelectedTrimId(v); const found = trims.find(t => t.value === v); setProfile((p: any) => ({ ...p, vehicle_trim: found?.text ?? '' })); }} style={styles.picker}>
                  <Picker.Item label="Select trim" value="" />
                  {trims.map((t) => <Picker.Item key={t.value} label={t.text} value={t.value} />)}
                </Picker>
              </View>
            ) : (
              <TextInput style={styles.input} value={profile.vehicle_trim} onChangeText={(t) => setProfile({ ...profile, vehicle_trim: t })} placeholder="Optional" placeholderTextColor="#bbb" />
            )}
          </Field>

          <Field label="Tank size (L)">
            <TextInput style={styles.input} keyboardType="numeric" value={profile.tank_size_l} onChangeText={(t) => setProfile({ ...profile, tank_size_l: t })} placeholder="e.g. 60" placeholderTextColor="#bbb" />
          </Field>

          {profile.fuel_efficiency ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoText}>{profile.fuel_efficiency} L/100km · {profile.fuel_type || 'Unknown fuel'}</Text>
            </View>
          ) : null}

          {lookupError && (
            <TouchableOpacity style={styles.warningRow} onPress={() => setManualFuelMode(!manualFuelMode)}>
              <Text style={styles.warningText}>Auto-lookup failed — tap to enter manually</Text>
            </TouchableOpacity>
          )}

          {manualFuelMode && (
            <>
              <Field label="Fuel efficiency (L/100km)">
                <TextInput style={styles.input} keyboardType="numeric" value={profile.fuel_efficiency} onChangeText={(t) => setProfile({ ...profile, fuel_efficiency: t })} placeholder="e.g. 10.5" placeholderTextColor="#bbb" />
              </Field>
              <Field label="Fuel type">
                <TextInput style={styles.input} value={profile.fuel_type} onChangeText={(t) => setProfile({ ...profile, fuel_type: t })} placeholder="e.g. Regular" placeholderTextColor="#bbb" />
              </Field>
            </>
          )}
        </View>

        {/* Location */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Home Location</Text>

          {profile.home_lat && profile.home_lng && (
            <View style={styles.coordsRow}>
              <Text style={styles.coordsText}>{parseFloat(profile.home_lat).toFixed(4)}, {parseFloat(profile.home_lng).toFixed(4)}</Text>
            </View>
          )}

          <TextInput
            style={[styles.input, { marginBottom: 8 }]}
            placeholder="Search your address..."
            placeholderTextColor="#bbb"
            value={addressInput}
            onChangeText={onAddressChange}
            autoCorrect={false}
          />
          {addressSuggestions.length > 0 && (
            <View style={styles.suggestions}>
              {addressSuggestions.map((item, i) => (
                <TouchableOpacity key={i} style={[styles.suggestion, i < addressSuggestions.length - 1 && styles.suggestionBorder]} onPress={() => selectAddress(item)}>
                  <Text style={styles.suggestionText} numberOfLines={2}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <TouchableOpacity style={styles.locBtn} onPress={getLocation} disabled={locationLoading}>
            {locationLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.locBtnText}>Or detect my location automatically</Text>}
          </TouchableOpacity>

          {locationFailed && locationError && (
            <Text style={[styles.locErrorText, { marginTop: 6 }]}>{locationError}</Text>
          )}
        </View>

        {/* Search Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Search Settings</Text>

          <SettingRow label="Search radius" unit="km" value={profile.search_radius_km} onChange={(t) => setProfile({ ...profile, search_radius_km: t })} placeholder="15" />
          <SettingRow label="Max detour" unit="km" value={profile.max_detour_km} onChange={(t) => setProfile({ ...profile, max_detour_km: t })} placeholder="5" />
          <SettingRow label="Min savings" unit="$" value={profile.min_savings} onChange={(t) => setProfile({ ...profile, min_savings: t })} placeholder="1.00" />
        </View>

        {/* Save */}
        <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldControl}>{children}</View>
    </View>
  );
}

function SettingRow({ label, unit, value, onChange, placeholder }: { label: string; unit: string; value: string; onChange: (t: string) => void; placeholder: string }) {
  return (
    <View style={[styles.fieldRow, styles.fieldRowBorder]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.settingInputWrap}>
        <TextInput style={styles.settingInput} keyboardType="numeric" value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="#bbb" />
        <Text style={styles.settingUnit}>{unit}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollView: { flex: 1, backgroundColor: '#f2f2f7' },
  scrollContent: { paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f2f2f7' },

  // Hero
  hero: {
    backgroundColor: '#1a1a2e',
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 28,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    marginBottom: 20,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 16,
  },
  backBtnText: { fontSize: 24, color: '#fff', lineHeight: 28, marginTop: -2 },
  heroTitle: { fontSize: 26, fontWeight: '700', color: '#fff' },
  heroSub: { fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 4 },

  // Banner
  banner: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fff3e0',
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bannerText: { fontSize: 13, color: '#e65100', flex: 1 },
  bannerDismiss: { fontSize: 13, color: '#4285F4', fontWeight: '600', marginLeft: 8 },

  // Section card
  section: {
    marginHorizontal: 16,
    marginBottom: 14,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 4,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingTop: 14,
    paddingBottom: 6,
  },

  // Field row
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
  },
  fieldRowBorder: {},
  fieldLabel: { fontSize: 14, color: '#333', width: 110 },
  fieldControl: { flex: 1 },

  // Picker
  pickerWrap: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fafafa',
  },
  picker: { height: 44 },

  // Text input
  input: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    backgroundColor: '#fafafa',
    color: '#1a1a2e',
  },

  // Fuel info
  infoRow: {
    backgroundColor: '#e8f5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 8,
  },
  infoText: { fontSize: 13, color: '#2e7d32' },
  warningRow: {
    backgroundColor: '#fff8e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 8,
  },
  warningText: { fontSize: 13, color: '#f57c00' },

  // Location
  coordsRow: {
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
  },
  coordsText: { fontSize: 13, color: '#666' },
  locBtn: {
    backgroundColor: '#4285F4',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginVertical: 10,
  },
  locBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  locFallback: { paddingBottom: 8 },
  locErrorText: { fontSize: 12, color: '#e65100', marginBottom: 6 },
  retryBtn: {
    borderWidth: 1,
    borderColor: '#4285F4',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  retryBtnText: { fontSize: 13, color: '#4285F4', fontWeight: '600' },
  suggestions: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  suggestion: { padding: 11 },
  suggestionBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  suggestionText: { fontSize: 13, color: '#333' },

  // Setting row
  settingInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settingInput: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    backgroundColor: '#fafafa',
    color: '#1a1a2e',
    width: 70,
    textAlign: 'right',
  },
  settingUnit: { fontSize: 13, color: '#888' },

  // Save
  saveBtn: {
    marginHorizontal: 16,
    backgroundColor: '#4285F4',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  saveBtnDisabled: { backgroundColor: '#a0bfee' },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});