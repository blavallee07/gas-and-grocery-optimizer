import { API_BASE } from '@/lib/config';
import { supabase } from '@/lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  Image,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

// ─── Brand logos ──────────────────────────────────────────────────────────────

const BRAND_LOGOS: Record<string, string> = {
  'shell': 'https://logo.clearbit.com/shell.com',
  'esso': 'https://logo.clearbit.com/esso.com',
  'petro-canada': 'https://logo.clearbit.com/petro-canada.ca',
  'ultramar': 'https://logo.clearbit.com/ultramar.ca',
  'canadian tire': 'https://logo.clearbit.com/canadiantire.ca',
  'costco': 'https://logo.clearbit.com/costco.com',
  'mobil': 'https://logo.clearbit.com/mobil.com',
  'pioneer': 'https://logo.clearbit.com/pioneerpetroleum.ca',
  '7-eleven': 'https://logo.clearbit.com/7eleven.com',
};

const BRAND_COLORS: Record<string, string> = {
  'shell': '#FBCE07',
  'esso': '#003087',
  'petro-canada': '#E4003A',
  'ultramar': '#E4003A',
  'canadian tire': '#CC0000',
  'costco': '#005DAA',
  '7-eleven': '#007140',
  'pioneer': '#E55B00',
};

function getBrandLogo(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [brand, url] of Object.entries(BRAND_LOGOS)) {
    if (lower.includes(brand)) return url;
  }
  return null;
}

function getBrandColor(name: string): string {
  const lower = name.toLowerCase();
  for (const [brand, color] of Object.entries(BRAND_COLORS)) {
    if (lower.includes(brand)) return color;
  }
  return '#4285F4';
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Station {
  id: string;
  name: string;
  address?: string;
  price_per_l: number | null;
  lat: number;
  lng: number;
  distance_km: number;
  driving_distance_km?: number;
  driving_duration_min?: number;
  price_updated_at?: string;
  photo_url?: string | null;
}

interface StationResult extends Station {
  gross_savings: number;
  detour_cost: number;
  net_savings: number;
  worth_it: boolean;
  is_baseline: boolean;
  sort_score: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LOCATION_DRIFT_KM = 5; // update profile if moved more than this

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Bouncing dots loader ─────────────────────────────────────────────────────

function BouncingDots() {
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(dot, { toValue: -10, duration: 300, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay((dots.length - i - 1) * 150),
        ])
      )
    );
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, []);

  return (
    <View style={dotStyles.row}>
      {dots.map((dot, i) => (
        <Animated.View key={i} style={[dotStyles.dot, { transform: [{ translateY: dot }] }]} />
      ))}
    </View>
  );
}

const dotStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#4285F4' },
});

// ─── Component ────────────────────────────────────────────────────────────────

export default function GasScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [stations, setStations] = useState<StationResult[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [currentCoords, setCurrentCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [currentAddress, setCurrentAddress] = useState<string | null>(null);
  const [userInitial, setUserInitial] = useState('?');

  // Responsive grid: 2 cols on mobile, 3 on tablet, 4 on desktop
  const numCols = width >= 1024 ? 4 : width >= 680 ? 3 : 2;
  const cardWidth = (width - 24 - (numCols - 1) * 12) / numCols;

  const openDirections = (station: Station) => {
    const dest = `${station.lat},${station.lng}`;
    const origin = profile?.home_lat && profile?.home_lng
      ? `&origin=${profile.home_lat},${profile.home_lng}`
      : '';
    Linking.openURL(
      `https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}&travelmode=driving`
    ).catch(() => {});
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async (forceRefresh = false) => {
    if (!forceRefresh) setLoading(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { router.replace('/login'); return; }

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      setProfile(profileData);

      // Set avatar initial from session email
      const email = session.user.email || '';
      const name = profileData?.full_name || email;
      setUserInitial((name).charAt(0).toUpperCase() || '?');

      // ── Auto GPS location ─────────────────────────────────────────────────
      let lat: number = profileData?.home_lat;
      let lng: number = profileData?.home_lng;

      const getGpsCoords = async (): Promise<{ latitude: number; longitude: number }> => {
        if (typeof window !== 'undefined' && window.navigator?.geolocation) {
          // Try browser geolocation, fall back to IP-based
          const browserPos = await new Promise<{ latitude: number; longitude: number } | null>((resolve) => {
            window.navigator.geolocation.getCurrentPosition(
              (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
              () => resolve(null),
              { timeout: 10000, enableHighAccuracy: true }
            );
          });
          if (browserPos) return browserPos;

          const res = await fetch('https://ipapi.co/json/');
          const data = await res.json();
          if (!data.latitude || !data.longitude) throw new Error('IP geolocation failed');
          return { latitude: data.latitude, longitude: data.longitude };
        }
        // Native: use expo-location
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') throw new Error('Permission denied');
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      };

      try {
        const { latitude: gpsLat, longitude: gpsLng } = await getGpsCoords();

        const hasStored = profileData?.home_lat && profileData?.home_lng;
        const distFromStored = hasStored
          ? haversineKm(profileData.home_lat, profileData.home_lng, gpsLat, gpsLng)
          : 0;

        // If GPS is more than 100km from the stored location, it's almost certainly
        // an IP-based fallback returning the wrong city — ignore it.
        const gpsSeemsTrustworthy = !hasStored || distFromStored < 100;

        if (gpsSeemsTrustworthy) {
          // Silently update stored location only for genuine small drift
          if (hasStored && distFromStored > LOCATION_DRIFT_KM) {
            supabase.from('profiles')
              .update({ home_lat: gpsLat, home_lng: gpsLng })
              .eq('id', session.user.id)
              .then(() => {});
          }
          lat = gpsLat;
          lng = gpsLng;
        } else {
          console.warn(`GPS returned location ${distFromStored.toFixed(0)}km from stored — likely IP fallback, ignoring.`);
        }
      } catch (e) {
        console.warn('GPS unavailable, falling back to stored location:', e);
      }

      if (!lat || !lng) {
        setError('Could not determine your location. Please set it in Profile.');
        return;
      }

      setCurrentCoords({ lat, lng });

      // Reverse geocode to show a readable address instead of raw coords
      fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`)
        .then(r => r.json())
        .then(d => {
          const p = d.features?.[0]?.properties || {};
          const parts = [p.street, p.city || p.town || p.village, p.county].filter(Boolean);
          if (parts.length) setCurrentAddress(parts.join(', '));
        })
        .catch(() => {});

      const cacheKey = `gas_v2_${lat.toFixed(3)}_${lng.toFixed(3)}`;

      // Return cached results if fresh and not forcing refresh
      if (!forceRefresh) {
        try {
          const cached = await AsyncStorage.getItem(cacheKey);
          if (cached) {
            const { stations: cachedStations, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < CACHE_TTL_MS) {
              setStations(rankStations(cachedStations, profileData));
              setLastUpdated(new Date(timestamp));
              return;
            }
          }
        } catch {}
      }

      const radius = profileData?.search_radius_km || 15;
      const url = `${API_BASE}/stations/nearby?lat=${lat}&lng=${lng}&radius=${radius}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Server error ${response.status}`);

      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to load stations');

      if (!data.stations?.length) {
        setError('No gas stations found within your search radius. Try increasing it in Profile.');
        return;
      }

      const now = Date.now();
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ stations: data.stations, timestamp: now })).catch(() => {});

      setStations(rankStations(data.stations, profileData));
      setLastUpdated(new Date(now));
    } catch (e: any) {
      console.error('Load error:', e);
      setError(e?.message || 'Failed to load gas stations.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setReloading(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setReloading(true);
    setStations([]);
    loadData(true);
  }, [profile]);

  const rankStations = (rawStations: Station[], prof: any): StationResult[] => {
    const withPrices = rawStations.filter(s => s.price_per_l !== null);
    if (!withPrices.length) return [];

    // Use driving distance when available; otherwise estimate from straight-line with road factor.
    // This keeps detour cost calculations consistent across all stations.
    const ROAD_FACTOR = 1.35;
    const effectiveDist = (s: Station) =>
      s.driving_distance_km ?? s.distance_km * ROAD_FACTOR;

    const baseline = withPrices.reduce((min, s) =>
      effectiveDist(s) < effectiveDist(min) ? s : min
    );
    const baselinePrice = baseline.price_per_l!;
    const baselineDist = effectiveDist(baseline);

    const tankSize = prof.tank_size_l || 50;
    const efficiency = prof.fuel_efficiency || 10;
    const minSavings = prof.min_savings || 1;
    const litersToFill = tankSize * 0.75;

    return withPrices.map(station => {
      const stationDist = effectiveDist(station);
      const detourKm = Math.max(0, (stationDist - baselineDist) * 2);
      const priceDiff = baselinePrice - station.price_per_l!;
      const grossSavings = priceDiff * litersToFill;
      const detourCost = (detourKm / 100) * efficiency * baselinePrice;
      const netSavings = grossSavings - detourCost;

      return {
        ...station,
        gross_savings: Math.round(grossSavings * 100) / 100,
        detour_cost: Math.round(detourCost * 100) / 100,
        net_savings: Math.round(netSavings * 100) / 100,
        worth_it: netSavings >= minSavings,
        is_baseline: station.id === baseline.id,
        sort_score: 0,
      };
    }).sort((a, b) => b.net_savings - a.net_savings);
  };

  const formatAge = (date: Date): string => {
    const mins = Math.round((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    return `${mins} min ago`;
  };

  // ─── States ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <BouncingDots />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorEmoji}>!</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => loadData(true)}>
          <Text style={styles.btnText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => router.push('/profile')}>
          <Text style={styles.btnSecondaryText}>Go to Profile</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.push('/')}>
            <Text style={styles.backBtnText}>‹</Text>
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>Gas Stations</Text>
            {(currentAddress || currentCoords) && (
              <Text style={styles.subtitle}>
                {currentAddress ?? `${currentCoords!.lat.toFixed(3)}, ${currentCoords!.lng.toFixed(3)}`}
                {lastUpdated ? ` · ${formatAge(lastUpdated)}` : ''}
              </Text>
            )}
          </View>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
            <Text style={styles.refreshBtnText}>{refreshing ? '...' : '↻ Refresh'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/profile')} style={styles.avatarBtn}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarLetter}>{userInitial}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Card grid or loading animation */}
      {reloading ? (
        <View style={styles.dotsContainer}>
          <BouncingDots />
        </View>
      ) : (
        <View style={styles.grid}>
          {stations.map((station, index) => (
            <StationCard
              key={station.id}
              station={station}
              cardWidth={index === 0 ? width - 24 : cardWidth}
              featured={index === 0}
              onPress={() => openDirections(station)}
            />
          ))}
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ─── Station card ─────────────────────────────────────────────────────────────

function StationCard({
  station,
  cardWidth,
  featured = false,
  onPress,
}: {
  station: StationResult;
  cardWidth: number;
  featured?: boolean;
  onPress: () => void;
}) {
  const logoUrl = getBrandLogo(station.name);
  const brandColor = getBrandColor(station.name);
  const dist = (station.driving_distance_km || station.distance_km).toFixed(1);

  return (
    <TouchableOpacity
      style={[styles.card, { width: cardWidth }, featured && styles.cardFeatured]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      {/* Brand header */}
      <View style={[styles.cardHeader, featured && styles.cardHeaderFeatured, { backgroundColor: brandColor }]}>
        {station.photo_url ? (
          <Image source={{ uri: station.photo_url }} style={styles.cardPhoto} resizeMode="cover" />
        ) : logoUrl ? (
          <Image source={{ uri: logoUrl }} style={styles.cardHeaderLogo} resizeMode="contain" />
        ) : (
          <Text style={styles.cardHeaderInitial}>{station.name.charAt(0)}</Text>
        )}

        {featured && (
          <View style={[styles.worthBadge, styles.featuredBadge]}>
            <Text style={styles.worthBadgeText}>Best Value</Text>
          </View>
        )}
        {!featured && station.is_baseline && (
          <View style={[styles.worthBadge, styles.closestBadge]}>
            <Text style={styles.worthBadgeText}>Closest</Text>
          </View>
        )}
      </View>

      {/* Info */}
      <View style={styles.cardBody}>
        <Text style={[styles.cardName, featured && styles.cardNameFeatured]} numberOfLines={1}>{station.name}</Text>
        <Text style={[styles.cardPrice, featured && styles.cardPriceFeatured]}>
          {station.price_per_l !== null ? `$${station.price_per_l.toFixed(3)}/L` : 'No price'}
        </Text>
        <View style={styles.cardMeta}>
          <Text style={styles.cardDist}>{dist} km</Text>
          {station.driving_duration_min ? (
            <Text style={styles.cardTime}> · {station.driving_duration_min} min</Text>
          ) : null}
        </View>
        {station.net_savings !== 0 && (
          <Text style={[
            styles.cardSavings,
            featured && styles.cardSavingsFeatured,
            station.net_savings > 0 ? styles.savingsPos : styles.savingsNeg,
          ]}>
            {station.net_savings > 0
              ? `Save $${station.net_savings.toFixed(2)}`
              : `$${Math.abs(station.net_savings).toFixed(2)} net loss`}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  scrollContent: { paddingBottom: 20 },
  dotsContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f2f2f7',
    gap: 12,
  },
  loadingText: { fontSize: 16, color: '#555', marginTop: 12 },
  errorEmoji: { fontSize: 52, marginBottom: 8 },
  errorText: { fontSize: 15, color: '#444', textAlign: 'center', lineHeight: 22 },
  btn: {
    backgroundColor: '#4285F4',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
    marginTop: 4,
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd' },
  btnSecondaryText: { color: '#444', fontWeight: '600', fontSize: 15 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 52,
    paddingBottom: 16,
  },
  title: { fontSize: 26, fontWeight: '700', color: '#1a1a2e' },
  subtitle: { fontSize: 12, color: '#888', marginTop: 2 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backBtnText: { fontSize: 24, color: '#4285F4', lineHeight: 28, marginTop: -2 },
  refreshBtn: {
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  refreshBtnText: { fontSize: 13, fontWeight: '600', color: '#4285F4' },
  avatarBtn: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden' },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#4285F4',
    justifyContent: 'center', alignItems: 'center',
  },
  avatarLetter: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    gap: 12,
  },

  // Card
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  cardHeader: {
    width: '100%',
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  cardHeaderFeatured: {
    height: 120,
  },
  cardPhoto: {
    position: 'absolute',
    width: '100%',
    height: '100%',
  },
  cardHeaderLogo: {
    width: '55%',
    height: '65%',
  },
  cardHeaderInitial: {
    fontSize: 36,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.5)',
  },
  cardFeatured: {
    borderWidth: 2,
    borderColor: '#2e7d32',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 6,
  },
  worthBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#2e7d32',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  featuredBadge: { backgroundColor: '#2e7d32' },
  closestBadge: { backgroundColor: '#1565c0' },
  worthBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  cardBody: { padding: 10 },
  cardName: { fontSize: 13, fontWeight: '700', color: '#1a1a2e', marginBottom: 4 },
  cardNameFeatured: { fontSize: 16 },
  cardPrice: { fontSize: 20, fontWeight: '800', color: '#1a1a2e', marginBottom: 4 },
  cardPriceFeatured: { fontSize: 28 },
  cardMeta: { flexDirection: 'row', alignItems: 'center' },
  cardDist: { fontSize: 12, color: '#666' },
  cardTime: { fontSize: 12, color: '#666' },
  cardSavings: { fontSize: 11, fontWeight: '600', marginTop: 4 },
  cardSavingsFeatured: { fontSize: 14 },
  savingsPos: { color: '#2e7d32' },
  savingsNeg: { color: '#c62828' },
});
