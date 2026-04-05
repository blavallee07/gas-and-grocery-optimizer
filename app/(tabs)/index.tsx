import { supabase } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function HomeScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [userName, setUserName] = useState<string>('');

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { router.replace('/login'); return; }
      setUserName(session.user.email?.split('@')[0] || 'there');
      const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      setProfile(data);
    } catch (e) {
      console.error('Load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  if (loading) {
    return <View style={s.centered}><ActivityIndicator size="large" color="#4285F4" /></View>;
  }

  const hasLocation = profile?.home_lat && profile?.home_lng;
  const hasVehicle = profile?.vehicle_year && profile?.vehicle_make;
  const vehicle = hasVehicle
    ? `${profile.vehicle_year} ${profile.vehicle_make}${profile.vehicle_model ? ' ' + profile.vehicle_model : ''}`
    : null;

  return (
    <View style={s.container}>
      {/* Dark header */}
      <View style={s.header}>
        <View>
          <Text style={s.greeting}>Hello, {userName}</Text>
          <Text style={s.sub}>Ready to save on gas?</Text>
        </View>
        <TouchableOpacity style={s.settingsBtn} onPress={() => router.push('/profile')}>
          <Text style={s.settingsBtnText}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Main CTA */}
      <View style={s.body}>
        <TouchableOpacity
          style={[s.cta, !hasLocation && s.ctaDisabled]}
          onPress={() => router.push('/gas')}
          disabled={!hasLocation}
          activeOpacity={0.88}
        >
          <Text style={s.ctaLabel}>Find Gas</Text>
          <Text style={s.ctaSub}>
            {hasLocation ? 'See the best prices near you' : 'Set your location in Settings first'}
          </Text>
        </TouchableOpacity>

        {/* Stats row */}
        <View style={s.statsRow}>
          <StatCard
            label="Vehicle"
            value={vehicle ?? '—'}
            dim={!hasVehicle}
            onPress={() => router.push('/profile')}
          />
          <StatCard
            label="Search radius"
            value={profile?.search_radius_km ? `${profile.search_radius_km} km` : '—'}
            dim={!profile?.search_radius_km}
            onPress={() => router.push('/profile')}
          />
          <StatCard
            label="Efficiency"
            value={profile?.fuel_efficiency ? `${profile.fuel_efficiency} L/100` : '—'}
            dim={!profile?.fuel_efficiency}
            onPress={() => router.push('/profile')}
          />
        </View>

        {/* Setup nudge */}
        {(!hasLocation || !hasVehicle) && (
          <TouchableOpacity style={s.nudge} onPress={() => router.push('/profile')}>
            <View style={s.nudgeDot} />
            <Text style={s.nudgeText}>
              {!hasLocation && !hasVehicle
                ? 'Set your location and vehicle to get started'
                : !hasLocation
                ? 'Set your location to find nearby prices'
                : 'Add your vehicle for accurate savings estimates'}
            </Text>
            <Text style={s.nudgeArrow}>›</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Sign out */}
      <TouchableOpacity style={s.signOut} onPress={handleSignOut}>
        <Text style={s.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

function StatCard({ label, value, dim, onPress }: { label: string; value: string; dim: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.stat, dim && s.statDim]} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.statValue} numberOfLines={1}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f2f2f7' },

  header: {
    backgroundColor: '#1a1a2e',
    paddingTop: 64,
    paddingBottom: 28,
    paddingHorizontal: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  greeting: { fontSize: 26, fontWeight: '700', color: '#fff' },
  sub: { fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 3 },
  settingsBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  settingsBtnText: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '500' },

  body: { flex: 1, paddingHorizontal: 20, paddingTop: 28, gap: 16 },

  cta: {
    backgroundColor: '#4285F4',
    borderRadius: 18,
    paddingVertical: 22,
    paddingHorizontal: 24,
    shadowColor: '#4285F4',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  ctaDisabled: {
    backgroundColor: '#9e9e9e',
    shadowColor: '#000',
    shadowOpacity: 0.08,
  },
  ctaLabel: { fontSize: 22, fontWeight: '700', color: '#fff' },
  ctaSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 4 },

  statsRow: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  statDim: { opacity: 0.45 },
  statValue: { fontSize: 13, fontWeight: '700', color: '#1a1a2e', marginBottom: 4 },
  statLabel: { fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.4 },

  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  nudgeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffb300' },
  nudgeText: { flex: 1, fontSize: 13, color: '#555', lineHeight: 18 },
  nudgeArrow: { fontSize: 18, color: '#ccc' },

  signOut: { paddingBottom: 36, alignItems: 'center' },
  signOutText: { fontSize: 13, color: '#bbb' },
});
