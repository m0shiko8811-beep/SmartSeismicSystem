import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy } from '../services/calculations';

const LEAFLET_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{margin:0;padding:0;height:100%;width:100%;background:#1a2233}
  .wp-label{background:#FF8F00;color:#fff;border:2px solid #fff;border-radius:4px;
    padding:2px 5px;font-size:11px;font-weight:800;white-space:nowrap}
  .pos-dot{width:16px;height:16px;border-radius:50%;background:#1565C0;
    border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.5)}
  #followBtn{position:absolute;bottom:30px;right:10px;z-index:1000;
    background:#fff;border:2px solid #ccc;border-radius:8px;
    padding:8px 12px;font-size:20px;cursor:pointer;line-height:1}
  #followBtn.active{border-color:#1565C0;background:#E3F2FD}
</style>
</head>
<body>
<div id="map"></div>
<button id="followBtn" class="active" onclick="toggleFollow()">🎯</button>
<script>
var map = L.map('map',{zoomControl:true,maxZoom:21}).setView([31.7683,35.2137],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:21,maxNativeZoom:19
}).addTo(map);

var posMarker = null;
var posCircle = null;
var wpMarkers = [];
var wpLine    = null;
var follow    = true;
var hasPos    = false;

function setFollow(v){
  follow = v;
  document.getElementById('followBtn').className = v ? 'active' : '';
}
function toggleFollow(){ setFollow(!follow); }

map.on('dragstart', function(){ setFollow(false); });

function posIcon(){
  return L.divIcon({className:'',html:'<div class="pos-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]});
}
function wpIcon(label){
  return L.divIcon({className:'',html:'<div class="wp-label">'+label+'</div>',iconAnchor:[0,10]});
}

window.updateGps = function(lat,lon,acc,fix){
  if(!fix) return;
  if(!posMarker){
    posMarker = L.marker([lat,lon],{icon:posIcon(),zIndexOffset:1000}).addTo(map);
  } else {
    posMarker.setLatLng([lat,lon]);
  }
  if(!posCircle){
    posCircle = L.circle([lat,lon],{radius:acc,color:'#1565C0',fillColor:'#1565C0',fillOpacity:0.15,weight:2}).addTo(map);
  } else {
    posCircle.setLatLng([lat,lon]).setRadius(acc);
  }
  if(!hasPos){ map.setView([lat,lon],17); hasPos=true; }
  else if(follow){ map.panTo([lat,lon]); }
};

window.updateWaypoints = function(wps){
  wpMarkers.forEach(function(m){map.removeLayer(m);}); wpMarkers=[];
  if(wpLine){map.removeLayer(wpLine);wpLine=null;}
  wps.forEach(function(wp){
    var m=L.marker([wp.lat,wp.lon],{icon:wpIcon(wp.label)}).addTo(map);
    m.bindPopup('<b>'+wp.label+'</b><br>'+wp.lat.toFixed(6)+', '+wp.lon.toFixed(6)+'<br>Alt: '+wp.alt.toFixed(1)+' m');
    wpMarkers.push(m);
  });
  if(wps.length>1){
    var coords=wps.map(function(w){return[w.lat,w.lon];});
    wpLine=L.polyline(coords,{color:'#FF8F00',weight:2,opacity:0.8}).addTo(map);
  }
};
</script>
</body>
</html>`;

export default function MapScreen() {
  const { gps, waypoints } = useGps();
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    if (!webRef.current || !gps) return;
    if (!Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) return;
    const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
    webRef.current.injectJavaScript(
      `window.updateGps(${gps.lat},${gps.lon},${acc},${gps.fix});true;`
    );
  }, [gps?.lat, gps?.lon, gps?.fix]);

  useEffect(() => {
    if (!webRef.current) return;
    const json = JSON.stringify(waypoints.map(w => ({
      lat: w.lat, lon: w.lon, alt: w.alt, label: w.label
    })));
    webRef.current.injectJavaScript(`window.updateWaypoints(${json});true;`);
  }, [waypoints]);

  const pushState = () => {
    if (!webRef.current) return;
    if (gps?.fix && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)) {
      const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
      webRef.current.injectJavaScript(
        `window.updateGps(${gps.lat},${gps.lon},${acc},${gps.fix});true;`
      );
    }
    if (waypoints.length > 0) {
      const json = JSON.stringify(waypoints.map(w => ({
        lat: w.lat, lon: w.lon, alt: w.alt, label: w.label
      })));
      webRef.current.injectJavaScript(`window.updateWaypoints(${json});true;`);
    }
  };

  return (
    <View style={s.container}>
      <WebView
        ref={webRef}
        style={s.map}
        source={{ html: LEAFLET_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onLoad={pushState}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
