import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { supabase } from '@/lib/supabase';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    const createProfileIfMissing = async (user: any) => {
      if (!user) return;

      try {
        const { data: existing, error: selectError } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', user.id)
          .maybeSingle();

        if (selectError) {
          console.error('Error checking for existing profile', selectError);
          return;
        }

        if (existing) {
          // Profile exists — update only the updated_at timestamp
          await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('id', user.id);
          return;
        }

        // Insert a new profile with sensible defaults for tracking purposes
        const newProfile = {
          id: user.id,
          email: user.email,
          full_name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
          avatar_url: user.user_metadata?.avatar_url ?? null,
          vehicle_year: null,
          vehicle_make: null,
          vehicle_model: null,
          vehicle_trim: null,
          tank_size_l: null,
          fuel_efficiency: null,
          fuel_type: null,
          home_lat: null,
          home_lng: null,
          max_detour_km: 5.0,
          min_savings: 1.0,
        };

        const { error: insertError } = await supabase.from('profiles').insert(newProfile, { returning: 'minimal' });
        if (insertError) console.error('Error inserting profile', insertError);
      } catch (e) {
        console.error('Error creating profile', e);
      }
    };

    // check current session on mount
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      if (session?.user) {
        createProfileIfMissing(session.user);
        router.replace('/');
      } else {
        router.replace('/login');
      }
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      if (user) {
        createProfileIfMissing(user);
        router.replace('/');
      } else {
        router.replace('/login');
      }
    });

    return () => {
      mounted = false;
      listener?.subscription.unsubscribe();
    };
  }, [router]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="profile" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="gas" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
