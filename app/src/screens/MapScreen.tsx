import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polyline, PROVIDER_OSM } from 'react-native-maps';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy } from '../services/calculations';
import { C } from '../theme';

// Israel default center
const DEFAULT_REGION = { latitude: 31.7683, longitude: 35.2137, latitudeDelta: 0.05, longitudeDelta: 0.05 };

export default function MapScreen() {
  const { gps, waypoints } = useGps();
  const mapRef = useRef<MapView>(null);

  useEffect(() => {
    if (gps?.fix && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: gps.lat, longitude: gps.lon,
        latitudeDelta: 0.002, longitudeDelta: 0.002,
      }, 500);
    }
  }, [gps?.fix]);

  return (
    <View style={s.container}>
      <MapView
        ref={mapRef}
        style={s.map}
        provider={PROVIDER_OSM}
        initialRegion={DEFAULT_REGION}
        showsUserLocation={false}
        showsMyLocationButton={false}
      >
        {/* Current position */}
        {gps?.fix && (
          <>
            <Marker coordinate={{ latitude: gps.lat, longitude: gps.lon }} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={s.posMarker} />
            </Marker>
            <Circle
              center={{ latitude: gps.lat, longitude: gps.lon }}
              radius={hdopToAccuracy(gps.hdop)}
              strokeColor="rgba(21,101,192,0.6)"
              fillColor="rgba(21,101,192,0.15)"
            />
          </>
        )}

        {/* Waypoints */}
        {waypoints.map(wp => (
          <Marker
            key={wp.id}
            coordinate={{ latitude: wp.lat, longitude: wp.lon }}
            title={wp.label}
            description={`${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} | Alt: ${wp.alt.toFixed(1)}m`}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={s.wpMarker}>
              <Text style={s.wpLabel}>{wp.label}</Text>
            </View>
          </Marker>
        ))}

        {/* Survey line */}
        {waypoints.length > 1 && (
          <Polyline
            coordinates={waypoints.map(wp => ({ latitude: wp.lat, longitude: wp.lon }))}
            strokeColor={C.amber}
            strokeWidth={2}
          />
        )}
      </MapView>

      {!gps?.fix && (
        <View style={s.overlay}>
          <Text style={s.overlayText}>No GPS fix — map shows last known position</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  posMarker: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#1565C0', borderWidth: 3, borderColor: '#fff' },
  wpMarker: { backgroundColor: '#FF8F00', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1.5, borderColor: '#fff' },
  wpLabel: { color: '#fff', fontWeight: '800', fontSize: 10 },
  overlay: { position: 'absolute', bottom: 20, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, padding: 10 },
  overlayText: { color: '#fff', textAlign: 'center', fontSize: 13 },
});
