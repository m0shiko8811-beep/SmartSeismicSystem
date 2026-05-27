import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
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
  .wp-label{display:inline-block;background:#1B3A1B;color:#00E676;border:2px solid #00E676;border-radius:4px;
    padding:2px 5px;font-size:11px;font-weight:800;white-space:nowrap}
  .dist-label{display:inline-block;background:#1565C0;color:#FF6D00;border:1px solid #FF6D00;
    border-radius:3px;padding:1px 4px;font-size:10px;font-weight:700;white-space:nowrap}
  .pos-dot{width:16px;height:16px;border-radius:50%;background:#1565C0;
    border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.5)}
  @keyframes pulse{0%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:0.6}100%{transform:scale(1);opacity:1}}
  .tap-dot{width:20px;height:20px;border-radius:50%;background:#FF6D00;
    border:3px solid #fff;box-shadow:0 0 8px rgba(255,109,0,0.8);
    animation:pulse 1.2s ease-in-out infinite}
  #controlBar{position:absolute;bottom:30px;right:10px;z-index:1000;display:flex;flex-direction:column;gap:6px}
  .mapBtn{background:#fff;border:2px solid #ccc;border-radius:8px;
    padding:8px 12px;font-size:20px;cursor:pointer;line-height:1;text-align:center}
  .mapBtn.active{border-color:#1565C0;background:#E3F2FD}
  .mapBtn.tapActive{border-color:#FF6D00;background:#FFF3E0}
</style>
</head>
<body>
<div id="map"></div>
<div id="controlBar">
  <button class="mapBtn tapActive" id="tapBtn" onclick="toggleTap()">📍</button>
  <button class="mapBtn active" id="followBtn" onclick="toggleFollow()">🎯</button>
</div>
<script>
var map = L.map('map',{zoomControl:true,minZoom:2,maxZoom:25}).setView([31.7683,35.2137],16);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:25,maxNativeZoom:19
}).addTo(map);

var posMarker = null;
var posCircle = null;
var wpMarkers = [];
var wpLines   = [];
var distMarkers = [];
var tapMarker = null;
var follow    = true;
var tapMode   = true;
var hasPos    = false;

window.clearGps = function(){
  if(posMarker){map.removeLayer(posMarker);posMarker=null;}
  if(posCircle){map.removeLayer(posCircle);posCircle=null;}
  hasPos=false;
};

function setFollow(v){
  follow = v;
  document.getElementById('followBtn').className = 'mapBtn' + (v ? ' active' : '');
}
function toggleFollow(){ setFollow(!follow); }

function setTapMode(v){
  tapMode = v;
  document.getElementById('tapBtn').className = 'mapBtn' + (v ? ' tapActive' : '');
}
function toggleTap(){ setTapMode(!tapMode); }

map.on('dragstart', function(){ setFollow(false); });

map.on('click', function(e){
  if(!tapMode) return;
  var lat = e.latlng.lat, lon = e.latlng.lng;
  placeTapMarker(lat, lon);
  if(window.ReactNativeWebView){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapTap',lat:lat,lon:lon}));
  }
});

function placeTapMarker(lat, lon){
  if(tapMarker){ map.removeLayer(tapMarker); tapMarker=null; }
  tapMarker = L.marker([lat,lon],{
    icon: L.divIcon({className:'',html:'<div class="tap-dot"></div>',iconSize:[20,20],iconAnchor:[10,10]}),
    zIndexOffset:500
  }).addTo(map);
}

window.setTapMarker = function(lat, lon){ placeTapMarker(lat, lon); setTapMode(true); };
window.clearTapMarker = function(){
  if(tapMarker){ map.removeLayer(tapMarker); tapMarker=null; }
  setTapMode(false);
};

function posIcon(){
  return L.divIcon({className:'',html:'<div class="pos-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]});
}
function wpIcon(label){
  return L.divIcon({className:'',html:'<div class="wp-label">'+label+'</div>',iconSize:[0,0],iconAnchor:[0,10]});
}
function distIcon(txt){
  return L.divIcon({className:'',html:'<div class="dist-label">'+txt+'</div>',iconSize:[0,0],iconAnchor:[20,10]});
}

function haversineM(la1,lo1,la2,lo2){
  var R=6371000,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;
  var a=Math.sin(dL/2)*Math.sin(dL/2)+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)*Math.sin(dO/2);
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
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

var LINE_COLORS=['#00E676','#FF6D00','#2196F3','#E91E63','#FFEB3B','#9C27B0'];

window.updateWaypoints = function(wps){
  wpMarkers.forEach(function(m){map.removeLayer(m);}); wpMarkers=[];
  distMarkers.forEach(function(m){map.removeLayer(m);}); distMarkers=[];
  wpLines.forEach(function(l){map.removeLayer(l);}); wpLines=[];

  // Group by label prefix before ':' (e.g. "1001" from "1001:5")
  var groups={}, groupOrder=[], colorMap={}, colorIdx=0;
  wps.forEach(function(wp){
    var sep=wp.label.indexOf(':');
    var key=sep>=0?wp.label.substring(0,sep):wp.label;
    var sta=sep>=0?parseInt(wp.label.substring(sep+1))||0:0;
    if(!groups[key]){
      groups[key]=[];
      groupOrder.push(key);
      colorMap[key]=LINE_COLORS[colorIdx%LINE_COLORS.length];
      colorIdx++;
    }
    groups[key].push({wp:wp,sta:sta});
  });

  groupOrder.forEach(function(key){
    var color=colorMap[key];
    var sorted=groups[key].slice().sort(function(a,b){return a.sta-b.sta;});

    sorted.forEach(function(item){
      var wp=item.wp;
      var icon=L.divIcon({className:'',
        html:'<div class="wp-label" style="border-color:'+color+';color:'+color+'">'+wp.label+'</div>',
        iconSize:[0,0],iconAnchor:[0,10]});
      var m=L.marker([wp.lat,wp.lon],{icon:icon}).addTo(map);
      m.bindPopup('<b>'+wp.label+'</b><br>'+wp.lat.toFixed(6)+', '+wp.lon.toFixed(6)+'<br>Alt: '+wp.alt.toFixed(1)+' m');
      wpMarkers.push(m);
    });

    if(sorted.length>1){
      var coords=sorted.map(function(item){return[item.wp.lat,item.wp.lon];});
      wpLines.push(L.polyline(coords,{color:color,weight:2,opacity:0.8}).addTo(map));
      for(var i=0;i<sorted.length-1;i++){
        var a=sorted[i].wp,b=sorted[i+1].wp;
        var midLat=(a.lat+b.lat)/2,midLon=(a.lon+b.lon)/2;
        var d=haversineM(a.lat,a.lon,b.lat,b.lon);
        var txt=d>=1000?(d/1000).toFixed(2)+'km':d.toFixed(1)+'m';
        distMarkers.push(L.marker([midLat,midLon],{icon:distIcon(txt),interactive:false}).addTo(map));
      }
    }
  });
};
</script>
</body>
</html>`;

export default function MapScreen() {
  const { gps, waypoints, mapTargetPos, setMapTargetPos } = useGps();
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    if (!webRef.current) return;
    if (!gps?.fix || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) {
      webRef.current.injectJavaScript(`window.clearGps();true;`);
      return;
    }
    const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
    webRef.current.injectJavaScript(
      `window.updateGps(${gps.lat},${gps.lon},${acc},true);true;`
    );
  }, [gps?.lat, gps?.lon, gps?.fix]);

  useEffect(() => {
    if (!webRef.current) return;
    const json = JSON.stringify(waypoints.map(w => ({
      lat: w.lat, lon: w.lon, alt: w.alt, label: w.label
    })));
    webRef.current.injectJavaScript(`window.updateWaypoints(${json});true;`);
  }, [waypoints]);

  // Sync tap marker with context state (e.g. when SurveyScreen clears it)
  useEffect(() => {
    if (!webRef.current) return;
    if (mapTargetPos) {
      webRef.current.injectJavaScript(
        `window.setTapMarker(${mapTargetPos.lat},${mapTargetPos.lon});true;`
      );
    } else {
      webRef.current.injectJavaScript(`window.clearTapMarker();true;`);
    }
  }, [mapTargetPos]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'mapTap') {
        const lat = Number(msg.lat), lon = Number(msg.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon) &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          setMapTargetPos({ lat, lon });
        }
      }
    } catch {}
  };

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
    if (mapTargetPos) {
      webRef.current.injectJavaScript(
        `window.setTapMarker(${mapTargetPos.lat},${mapTargetPos.lon});true;`
      );
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
        onMessage={onMessage}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
