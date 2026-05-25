import 'react-native-gesture-handler';
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';

import { GpsProvider } from './src/context/GpsContext';
import StatusScreen   from './src/screens/StatusScreen';
import MapScreen      from './src/screens/MapScreen';
import SurveyScreen   from './src/screens/SurveyScreen';
import LogScreen      from './src/screens/LogScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { C } from './src/theme';

const Tab = createBottomTabNavigator();

function Icon({ label, focused }: { label: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Status: '📡', Map: '🗺', Survey: '📍', Log: '📋', Settings: '⚙️',
  };
  return <Text style={{ fontSize: focused ? 22 : 18 }}>{icons[label] ?? '●'}</Text>;
}

export default function App() {
  return (
    <GpsProvider>
      <NavigationContainer>
        <StatusBar style="dark" />
        <Tab.Navigator
          screenOptions={({ route }) => ({
            tabBarIcon: ({ focused }) => <Icon label={route.name} focused={focused} />,
            tabBarActiveTintColor: C.accent,
            tabBarInactiveTintColor: C.muted,
            tabBarStyle: { backgroundColor: C.card, borderTopColor: C.border },
            headerStyle: { backgroundColor: C.card },
            headerTintColor: C.accent,
            headerTitleStyle: { fontWeight: '800' },
          })}
        >
          <Tab.Screen name="Status"   component={StatusScreen}   options={{ title: 'GPS Status' }} />
          <Tab.Screen name="Map"      component={MapScreen}      options={{ title: 'Map' }} />
          <Tab.Screen name="Survey"   component={SurveyScreen}   options={{ title: 'Survey' }} />
          <Tab.Screen name="Log"      component={LogScreen}      options={{ title: 'Log' }} />
          <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </Tab.Navigator>
      </NavigationContainer>
    </GpsProvider>
  );
}
