import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, PanResponder, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy, fixQualityName } from '../services/calculations';
import { C } from '../theme';

const LEAFLET_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js"></script>
<style>
  html,body,#map{margin:0;padding:0;height:100%;width:100%;background:#1a2233}
  .wp-label{display:inline-block;background:#1B3A1B;color:#00E676;border:2px solid #00E676;border-radius:4px;
    padding:2px 5px;font-size:11px;font-weight:800;white-space:nowrap}
  .dist-label{display:inline-block;background:#1565C0;color:#FF6D00;border:1px solid #FF6D00;
    border-radius:3px;padding:1px 4px;font-size:10px;font-weight:700;white-space:nowrap}
  .sk-dot{width:22px;height:22px;border-radius:50%;border:3px solid #FF6D00;background:rgba(255,109,0,0.25)}
  .sk-dot.active{background:#FF6D00;box-shadow:0 0 10px rgba(255,109,0,0.8)}
  .sk-label{display:inline-block;background:#FF6D00;color:#fff;border-radius:4px;
    padding:2px 6px;font-size:11px;font-weight:800;white-space:nowrap}
  .pos-dot{width:16px;height:16px;border-radius:50%;background:#1565C0;
    border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.5)}
  @keyframes pulse{0%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:0.6}100%{transform:scale(1);opacity:1}}
  .tap-dot{width:20px;height:20px;border-radius:50%;background:#FF6D00;
    border:3px solid #fff;box-shadow:0 0 8px rgba(255,109,0,0.8);
    animation:pulse 1.2s ease-in-out infinite}
  .ref-label{display:inline-block;background:#1a1a2e;color:#9E9E9E;border:1px dashed #9E9E9E;border-radius:3px;padding:1px 4px;font-size:10px;white-space:nowrap}
  .pred-dot{width:20px;height:20px;border-radius:50%;background:rgba(255,109,0,0.15);border:2px dashed #FF6D00}
  .shot-star{display:inline-block;font-size:18px;line-height:1;filter:drop-shadow(0 0 3px rgba(0,0,0,0.6))}
  .shot-plan-star{display:inline-block;font-size:16px;line-height:1;opacity:0.55}
  .shot-label{display:inline-block;background:#7B1FA2;color:#fff;border-radius:3px;padding:1px 4px;font-size:10px;font-weight:800;white-space:nowrap}
  .compass-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}
  .compass-needle{font-size:18px;display:block;transition:transform 0.3s ease}
  .compass-deg{font-size:8px;font-weight:700;color:#666;margin-top:1px}
  #controlBar{position:absolute;bottom:30px;right:10px;z-index:1000;display:flex;flex-direction:column;gap:6px}
  .mapBtn{background:#fff;border:2px solid #ccc;border-radius:8px;
    padding:8px 12px;font-size:20px;cursor:pointer;line-height:1;text-align:center}
  .mapBtn.active{border-color:#1565C0;background:#E3F2FD}
  .mapBtn.tapActive{border-color:#FF6D00;background:#FFF3E0}
  .mapBtn.caching{border-color:#4CAF50;background:#E8F5E9}
  #cacheStatus{position:absolute;top:0;left:0;right:0;z-index:2000;
    background:rgba(21,101,192,0.93);color:#fff;font-size:12px;font-weight:700;
    padding:7px 10px;display:none;text-align:center}
</style>
</head>
<body>
<div id="map"></div>
<div id="cacheStatus"></div>
<div id="controlBar">
  <button class="mapBtn active" id="northBtn" onclick="toggleNorthLock()" title="North lock / reset to North">
    <div class="compass-btn"><span class="compass-needle" id="compassNeedle">&#129517;</span><span class="compass-deg" id="compassDeg">N</span></div>
  </button>
  <button class="mapBtn" id="satBtn" onclick="toggleBasemap()" title="Toggle satellite imagery">&#128752;</button>
  <button class="mapBtn" id="cacheBtn" onclick="startCacheArea()" title="Cache tiles for offline use">&#128190;</button>
  <button class="mapBtn tapActive" id="tapBtn" onclick="toggleTap()">&#128205;</button>
  <button class="mapBtn active" id="followBtn" onclick="toggleFollow()">&#127919;</button>
</div>
<script>
// ── IndexedDB tile cache ──────────────────────────────────────
var _db=null;
function openDB(cb){
  if(_db){cb(_db);return;}
  var r=indexedDB.open('gps_map_tiles',1);
  r.onupgradeneeded=function(e){e.target.result.createObjectStore('tiles');};
  r.onsuccess=function(e){_db=e.target.result;cb(_db);};
  r.onerror=function(){cb(null);};
}
function getTile(key,cb){
  openDB(function(db){
    if(!db){cb(null);return;}
    try{var tx=db.transaction('tiles','readonly');var req=tx.objectStore('tiles').get(key);
      req.onsuccess=function(){cb(req.result||null);};req.onerror=function(){cb(null);};}
    catch(e){cb(null);}
  });
}
function putTile(key,data,cb){
  openDB(function(db){
    if(!db){if(cb)cb();return;}
    try{var tx=db.transaction('tiles','readwrite');tx.objectStore('tiles').put(data,key);
      tx.oncomplete=function(){if(cb)cb();};}
    catch(e){if(cb)cb();}
  });
}

// ── Offline-capable tile layer ────────────────────────────────
var OfflineTileLayer=L.TileLayer.extend({
  createTile:function(coords,done){
    var img=document.createElement('img');
    img.setAttribute('role','presentation');
    var key=coords.z+'/'+coords.x+'/'+coords.y;
    var url=this.getTileUrl(coords);
    getTile(key,function(cached){
      if(cached){
        img.onload=function(){done(null,img);};
        img.onerror=function(){
          // cached data-url failed — fall back to network (no crossOrigin)
          img.onload=function(){done(null,img);};
          img.onerror=function(e){done(e,img);};
          img.src=url;
        };
        img.src=cached;
      }else{
        img.onload=function(){
          done(null,img);
          // Try canvas cache — may fail with tainted-canvas if server blocks CORS
          // that's fine, tile still displayed above
          try{
            var c=document.createElement('canvas');c.width=c.height=256;
            c.getContext('2d').drawImage(img,0,0);
            putTile(key,c.toDataURL('image/png'));
          }catch(e){}
        };
        img.onerror=function(e){done(e,img);};
        img.src=url;
      }
    });
    return img;
  }
});

// ── Basemap state — declared here so assignment below doesn't get overwritten ──
var currentBasemap='osm';
var osmLayer=null,satLayer=null;

function makeOsmLayer(){
  return new OfflineTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OpenStreetMap',maxZoom:25,maxNativeZoom:19,subdomains:'abc'});
}
function makeSatLayer(){
  // Plain L.tileLayer (no crossOrigin) so ESRI tiles load without CORS errors
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
    attribution:'© Esri World Imagery',maxZoom:25,maxNativeZoom:19});
}
function toggleBasemap(){
  if(currentBasemap==='osm'){
    currentBasemap='sat';
    if(osmLayer){map.removeLayer(osmLayer);osmLayer=null;}
    if(!satLayer){satLayer=makeSatLayer();}
    satLayer.addTo(map);satLayer.bringToBack();
    document.getElementById('satBtn').className='mapBtn active';
  }else{
    currentBasemap='osm';
    if(satLayer){map.removeLayer(satLayer);satLayer=null;}
    if(!osmLayer){osmLayer=makeOsmLayer();}
    osmLayer.addTo(map);osmLayer.bringToBack();
    document.getElementById('satBtn').className='mapBtn';
  }
}

// ── Map init ──────────────────────────────────────────────────
var map=L.map('map',{zoomControl:true,minZoom:2,maxZoom:25,rotate:true,touchRotate:true,bearing:0}).setView([31.7683,35.2137],16);
osmLayer=new OfflineTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:25,maxNativeZoom:19,subdomains:'abc'
}).addTo(map);
L.control.scale({imperial:false,maxWidth:200,position:'bottomleft'}).addTo(map);

// ── North lock (rotation driven from React Native via injectJavaScript) ──
var northLocked=true;
var _bearing=0;

function updateCompassUI(){
  var deg=Math.round(_bearing);
  var el=document.getElementById('compassNeedle');
  var dl=document.getElementById('compassDeg');
  if(el) el.style.transform='rotate('+deg+'deg)';
  if(dl) dl.textContent=(deg===0||northLocked)?'N':deg+'°';
  document.getElementById('northBtn').className='mapBtn'+(northLocked?' active':'');
}

// Called by React Native injectJavaScript when rotation gesture fires
window.setBearing=function(deg){
  _bearing=((deg%360)+360)%360;
  if(map.rotateTo){try{map.rotateTo(_bearing,{animate:false});}catch(e){}}
  updateCompassUI();
};

function toggleNorthLock(){
  northLocked=!northLocked;
  if(northLocked){
    _bearing=0;
    if(map.rotateTo){try{map.rotateTo(0,{animate:true});}catch(e){}}
    updateCompassUI();
  } else {
    updateCompassUI();
  }
  if(window.ReactNativeWebView){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'northLock',locked:northLocked}));
  }
}

setTimeout(function(){updateCompassUI();},400);

// ── Utilities ─────────────────────────────────────────────────
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function haversineM(la1,lo1,la2,lo2){
  var R=6371000,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;
  var a=Math.sin(dL/2)*Math.sin(dL/2)+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)*Math.sin(dO/2);
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function latLngToTileXY(lat,lng,z){
  var n=Math.pow(2,z),latR=lat*Math.PI/180;
  return{x:Math.floor((lng+180)/360*n),y:Math.floor((1-Math.log(Math.tan(latR)+1/Math.cos(latR))/Math.PI)/2*n)};
}

// ── Map state ─────────────────────────────────────────────────
var posMarker=null,posCircle=null,wpMarkers=[],wpLines=[],distMarkers=[],tapMarker=null;
var follow=true,tapMode=true,hasPos=false;

window.clearGps=function(){
  if(posMarker){map.removeLayer(posMarker);posMarker=null;}
  if(posCircle){map.removeLayer(posCircle);posCircle=null;}
  hasPos=false;
};

function setFollow(v){follow=v;document.getElementById('followBtn').className='mapBtn'+(v?' active':'');}
function toggleFollow(){setFollow(!follow);}
function setTapMode(v){tapMode=v;document.getElementById('tapBtn').className='mapBtn'+(v?' tapActive':'');}
function toggleTap(){setTapMode(!tapMode);}

map.on('dragstart',function(){setFollow(false);});
map.on('click',function(e){
  if(!tapMode)return;
  var lat=e.latlng.lat,lon=e.latlng.lng;
  placeTapMarker(lat,lon);
  if(window.ReactNativeWebView)
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapTap',lat:lat,lon:lon}));
});

function placeTapMarker(lat,lon){
  if(tapMarker){map.removeLayer(tapMarker);tapMarker=null;}
  tapMarker=L.marker([lat,lon],{
    icon:L.divIcon({className:'',html:'<div class="tap-dot"></div>',iconSize:[20,20],iconAnchor:[10,10]}),
    zIndexOffset:500}).addTo(map);
}
window.setTapMarker=function(lat,lon){placeTapMarker(lat,lon);setTapMode(true);};
window.clearTapMarker=function(){if(tapMarker){map.removeLayer(tapMarker);tapMarker=null;}setTapMode(false);};

function posIcon(){return L.divIcon({className:'',html:'<div class="pos-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]});}
function distIcon(txt){return L.divIcon({className:'',html:'<div class="dist-label">'+escHtml(txt)+'</div>',iconSize:[0,0],iconAnchor:[20,10]});}

window.updateGps=function(lat,lon,acc,fix){
  if(!fix)return;
  if(!posMarker){posMarker=L.marker([lat,lon],{icon:posIcon(),zIndexOffset:1000}).addTo(map);}
  else{posMarker.setLatLng([lat,lon]);}
  if(!posCircle){posCircle=L.circle([lat,lon],{radius:acc,color:'#1565C0',fillColor:'#1565C0',fillOpacity:0.15,weight:2}).addTo(map);}
  else{posCircle.setLatLng([lat,lon]).setRadius(acc);}
  if(!hasPos){map.setView([lat,lon],17);hasPos=true;}
  else if(follow){map.panTo([lat,lon]);}
};

// ── Stakeout overlay ──────────────────────────────────────────
var skMarkers=[],skLine=null;
window.updateStakeout=function(targets,activeIdx){
  skMarkers.forEach(function(m){map.removeLayer(m);});skMarkers=[];
  if(skLine){map.removeLayer(skLine);skLine=null;}
  if(!targets||!targets.length)return;
  var coords=[];
  targets.forEach(function(t,i){
    var isActive=(i===activeIdx);
    skMarkers.push(L.marker([t.lat,t.lon],{
      icon:L.divIcon({className:'',html:'<div class="sk-dot'+(isActive?' active':'')+'"></div>',iconSize:[22,22],iconAnchor:[11,11]}),
      zIndexOffset:800}).addTo(map));
    skMarkers.push(L.marker([t.lat,t.lon],{
      icon:L.divIcon({className:'',html:'<div class="sk-label">'+escHtml(t.label)+'</div>',iconSize:[0,0],iconAnchor:[-4,12]}),
      interactive:false}).addTo(map));
    coords.push([t.lat,t.lon]);
  });
  if(coords.length>1)skLine=L.polyline(coords,{color:'#FF6D00',weight:1.5,opacity:0.5,dashArray:'5,5'}).addTo(map);
};

// ── Predicted next station ────────────────────────────
var predMarker=null;
window.updatePredicted=function(lat,lon){
  if(predMarker){map.removeLayer(predMarker);predMarker=null;}
  predMarker=L.marker([lat,lon],{
    icon:L.divIcon({className:'',html:'<div class="pred-dot"></div>',iconSize:[20,20],iconAnchor:[10,10]}),
    zIndexOffset:400,interactive:false}).addTo(map);
};
window.clearPredicted=function(){if(predMarker){map.removeLayer(predMarker);predMarker=null;}};

// ── Reference layer (planned points) ─────────────────
var refMarkers=[];
window.updateRefLayer=function(pts){
  refMarkers.forEach(function(m){map.removeLayer(m);});refMarkers=[];
  if(!pts||!pts.length)return;
  pts.forEach(function(pt){
    var m=L.marker([pt.lat,pt.lon],{
      icon:L.divIcon({className:'',html:'<div class="ref-label">'+escHtml(pt.label)+'</div>',iconSize:[0,0],iconAnchor:[0,10]}),
      interactive:false,zIndexOffset:100}).addTo(map);
    refMarkers.push(m);
  });
};

// ── Shot plan overlay (planned source points, hollow star) ────
var shotPlanMarkers=[];
window.updateShotPlan=function(pts){
  shotPlanMarkers.forEach(function(m){map.removeLayer(m);});shotPlanMarkers=[];
  if(!pts||!pts.length)return;
  pts.forEach(function(pt){
    var m=L.marker([pt.lat,pt.lon],{
      icon:L.divIcon({className:'',
        html:'<span class="shot-plan-star" title="'+escHtml(pt.label)+'">☆</span>',
        iconSize:[18,18],iconAnchor:[9,9]}),
      interactive:false,zIndexOffset:150}).addTo(map);
    shotPlanMarkers.push(m);
    var lbl=L.marker([pt.lat,pt.lon],{
      icon:L.divIcon({className:'',html:'<div class="ref-label">'+escHtml(pt.label)+'</div>',iconSize:[0,0],iconAnchor:[0,10]}),
      interactive:false,zIndexOffset:150}).addTo(map);
    shotPlanMarkers.push(lbl);
  });
};

// ── Shot overlay (triggered shots, solid star) ────────────────
var LINE_COLORS_SHOT=['#CE93D8','#FF6D00','#2196F3','#E91E63','#FFEB3B','#00E676'];
var shotMarkers=[];
window.updateShots=function(shots){
  shotMarkers.forEach(function(m){map.removeLayer(m);});shotMarkers=[];
  if(!shots||!shots.length)return;
  var lineColorMap={},lineColorIdx=0;
  shots.forEach(function(sh){
    var key='L'+sh.line;
    if(!lineColorMap[key]){lineColorMap[key]=LINE_COLORS_SHOT[lineColorIdx%LINE_COLORS_SHOT.length];lineColorIdx++;}
    var color=lineColorMap[key];
    var bad=sh.bad;
    var star=bad?'☆':'★';
    var timePart=sh.ts&&sh.ts.length>=19?sh.ts.substring(11,23):sh.ts;
    var popup='<b>L'+escHtml(String(sh.line))+' SP'+escHtml(String(sh.sp))+'</b><br>'+escHtml(timePart)+'<br>'+escHtml(sh.fixQ===4?'RTK Fixed':sh.fixQ===5?'RTK Float':sh.fixQ===2?'DGPS':'GPS');
    var m=L.marker([sh.lat,sh.lon],{
      icon:L.divIcon({className:'',
        html:'<span class="shot-star" style="color:'+color+';opacity:'+(bad?0.4:1)+'">'+star+'</span>',
        iconSize:[20,20],iconAnchor:[10,10]}),
      zIndexOffset:600}).addTo(map);
    m.bindPopup(popup);
    shotMarkers.push(m);
    var lbl=L.marker([sh.lat,sh.lon],{
      icon:L.divIcon({className:'',html:'<div class="shot-label" style="background:'+color+'">SP'+escHtml(String(sh.sp))+'</div>',iconSize:[0,0],iconAnchor:[-2,12]}),
      interactive:false,zIndexOffset:590}).addTo(map);
    shotMarkers.push(lbl);
  });
};

// ── Waypoint overlay ──────────────────────────────────────────
var LINE_COLORS=['#00E676','#FF6D00','#2196F3','#E91E63','#FFEB3B','#9C27B0'];
window.updateWaypoints=function(wps){
  wpMarkers.forEach(function(m){map.removeLayer(m);});wpMarkers=[];
  distMarkers.forEach(function(m){map.removeLayer(m);});distMarkers=[];
  wpLines.forEach(function(l){map.removeLayer(l);});wpLines=[];
  var groups={},groupOrder=[],colorMap={},colorIdx=0;
  wps.forEach(function(wp){
    var sep=wp.label.indexOf(':');
    var key=sep>=0?wp.label.substring(0,sep):wp.label;
    var sta=sep>=0?parseInt(wp.label.substring(sep+1))||0:0;
    if(!groups[key]){groups[key]=[];groupOrder.push(key);colorMap[key]=LINE_COLORS[colorIdx%LINE_COLORS.length];colorIdx++;}
    groups[key].push({wp:wp,sta:sta});
  });
  groupOrder.forEach(function(key){
    var color=colorMap[key];
    var sorted=groups[key].slice().sort(function(a,b){return a.sta-b.sta;});
    sorted.forEach(function(item){
      var wp=item.wp,flagStar=wp.flagged?' ⚑':'';
      var m=L.marker([wp.lat,wp.lon],{icon:L.divIcon({className:'',
        html:'<div class="wp-label" style="border-color:'+color+';color:'+color+'">'+escHtml(wp.label)+flagStar+'</div>',
        iconSize:[0,0],iconAnchor:[0,10]})}).addTo(map);
      m.on('click',function(e){
        L.DomEvent.stopPropagation(e);
        if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({
          type:'wpTap',label:wp.label,lat:wp.lat,lon:wp.lon,alt:wp.alt,hdop:wp.hdop,fixQ:wp.fixQ,ts:wp.ts,flagged:wp.flagged
        }));
      });
      wpMarkers.push(m);
    });
    if(sorted.length>1){
      var coords=sorted.map(function(item){return[item.wp.lat,item.wp.lon];});
      wpLines.push(L.polyline(coords,{color:color,weight:2,opacity:0.8}).addTo(map));
      for(var i=0;i<sorted.length-1;i++){
        var a=sorted[i].wp,b=sorted[i+1].wp;
        var d=haversineM(a.lat,a.lon,b.lat,b.lon);
        var txt=d>=1000?(d/1000).toFixed(2)+'km':d.toFixed(1)+'m';
        distMarkers.push(L.marker([(a.lat+b.lat)/2,(a.lon+b.lon)/2],{icon:distIcon(txt),interactive:false}).addTo(map));
      }
    }
  });
};

// ── Offline tile area caching ─────────────────────────────────
var _caching=false;
function showCacheStatus(msg){
  var el=document.getElementById('cacheStatus');
  if(!msg){el.style.display='none';}else{el.textContent=msg;el.style.display='block';}
}

function startCacheArea(){
  if(_caching)return;
  var bounds=map.getBounds();
  var curZ=Math.floor(map.getZoom());
  var maxZ=Math.min(curZ,17);
  var minZ=Math.max(10,maxZ-3);
  var tiles=[];
  for(var z=minZ;z<=maxZ;z++){
    var nw=latLngToTileXY(bounds.getNorth(),bounds.getWest(),z);
    var se=latLngToTileXY(bounds.getSouth(),bounds.getEast(),z);
    for(var x=nw.x;x<=se.x;x++){for(var y=nw.y;y<=se.y;y++){tiles.push({z:z,x:x,y:y});}}
  }
  var total=tiles.length;
  if(total===0){showCacheStatus('No tiles in view');setTimeout(function(){showCacheStatus(null);},2000);return;}
  if(total>1000){
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'cacheTooLarge',count:total}));
    return;
  }
  _caching=true;
  document.getElementById('cacheBtn').className='mapBtn caching';
  var done=0;
  function next(){
    if(tiles.length===0){
      _caching=false;
      document.getElementById('cacheBtn').className='mapBtn';
      showCacheStatus(null);
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'cacheComplete',count:total,new:(total-done)}));
      return;
    }
    var t=tiles.shift();
    var key=t.z+'/'+t.x+'/'+t.y;
    getTile(key,function(cached){
      done++;
      showCacheStatus('Caching tiles… '+done+'/'+total);
      if(cached){setTimeout(next,0);return;}
      var url='https://tile.openstreetmap.org/'+t.z+'/'+t.x+'/'+t.y+'.png';
      var xhr=new XMLHttpRequest();
      xhr.open('GET',url,true);xhr.responseType='blob';
      xhr.onload=function(){
        if(xhr.status===200){
          var r=new FileReader();
          r.onloadend=function(){putTile(key,r.result,function(){setTimeout(next,15);});};
          r.readAsDataURL(xhr.response);
        }else{setTimeout(next,0);}
      };
      xhr.onerror=function(){setTimeout(next,0);};
      xhr.send();
    });
  }
  showCacheStatus('Starting… '+total+' tiles');
  next();
}

window.clearTileCache=function(){
  openDB(function(db){
    if(!db)return;
    try{
      var tx=db.transaction('tiles','readwrite');
      tx.objectStore('tiles').clear();
      tx.oncomplete=function(){
        if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'cacheClear'}));
      };
    }catch(e){}
  });
};
</script>
</body>
</html>`;

export default function MapScreen() {
  const { gps, waypoints, mapTargetPos, setMapTargetPos, deleteWaypointByLabel, flaggedLabels, toggleFlag,
          stakeoutTargets, stakeoutIdx, predictedNextPos, refPoints, saveWaypoint,
          shots, shotPlan } = useGps();
  const webRef         = useRef<WebView>(null);
  const webViewReady   = useRef(false);
  const northLockedRef = useRef(true);
  const bearingRef     = useRef(0);
  const rotGesture     = useRef({ startAngle: 0, startBearing: 0, active: false });

  const getAngle = (touches: { pageX: number; pageY: number }[]) =>
    Math.atan2(touches[1].pageY - touches[0].pageY,
               touches[1].pageX - touches[0].pageX) * 180 / Math.PI;

  // Transparent overlay PanResponder — only claims 2-finger when North is unlocked.
  // Single-finger and locked-2-finger touches fall through to the WebView underneath.
  const rotPR = useRef(
    PanResponder.create({
      // Never capture on start — let WebView handle initial touch (buttons, taps, zoom)
      onStartShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      // Only steal mid-move when 2 fingers detected and North is unlocked
      onMoveShouldSetPanResponderCapture: (e) =>
        e.nativeEvent.touches.length === 2 && !northLockedRef.current,
      onMoveShouldSetPanResponder: (e) =>
        e.nativeEvent.touches.length === 2 && !northLockedRef.current,
      onPanResponderGrant: (e) => {
        const t = [...e.nativeEvent.touches] as any[];
        rotGesture.current = { startAngle: getAngle(t), startBearing: bearingRef.current, active: true };
      },
      onPanResponderMove: (e) => {
        if (!rotGesture.current.active) return;
        const t = [...e.nativeEvent.touches] as any[];
        if (t.length < 2) return;
        const delta = getAngle(t) - rotGesture.current.startAngle;
        const nb = (((rotGesture.current.startBearing - delta) % 360) + 360) % 360;
        bearingRef.current = nb;
        webRef.current?.injectJavaScript(`window.setBearing(${nb.toFixed(2)});true;`);
      },
      onPanResponderRelease: () => { rotGesture.current.active = false; },
      onPanResponderTerminate: () => { rotGesture.current.active = false; },
    })
  ).current;

  const [tapPos, setTapPos]       = useState<{ lat: number; lon: number } | null>(null);
  const [tapLabel, setTapLabel]   = useState('');
  const [tapSaving, setTapSaving] = useState(false);

  useEffect(() => {
    if (!webRef.current) return;
    if (!gps?.fix || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) {
      webRef.current.injectJavaScript(`window.clearGps();true;`);
      return;
    }
    const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
    webRef.current.injectJavaScript(`window.updateGps(${gps.lat},${gps.lon},${acc},true);true;`);
  }, [gps?.lat, gps?.lon, gps?.fix]);

  useEffect(() => {
    if (!webRef.current) return;
    const json = JSON.stringify(waypoints.map(w => ({
      lat: w.lat, lon: w.lon, alt: w.alt,
      hdop: w.hdop, fixQ: w.fixQ, ts: w.ts,
      label: w.label, flagged: flaggedLabels.has(w.label),
    })));
    webRef.current.injectJavaScript(`window.updateWaypoints(${json});true;`);
  }, [waypoints, flaggedLabels]);

  useEffect(() => {
    if (!webRef.current) return;
    const json = JSON.stringify(stakeoutTargets);
    webRef.current.injectJavaScript(`window.updateStakeout(${json},${stakeoutIdx});true;`);
  }, [stakeoutTargets, stakeoutIdx]);

  useEffect(() => {
    if (!webRef.current) return;
    if (predictedNextPos) {
      webRef.current.injectJavaScript(`window.updatePredicted(${predictedNextPos.lat},${predictedNextPos.lon});true;`);
    } else {
      webRef.current.injectJavaScript(`window.clearPredicted();true;`);
    }
  }, [predictedNextPos]);

  useEffect(() => {
    if (!webRef.current) return;
    const json = JSON.stringify(refPoints);
    webRef.current.injectJavaScript(`window.updateRefLayer(${json});true;`);
  }, [refPoints]);

  useEffect(() => {
    if (!webRef.current || !webViewReady.current) return;
    const json = JSON.stringify(shots.map(s => ({
      lat: s.lat, lon: s.lon, line: s.line, sp: s.sp, ts: s.ts, fixQ: s.fixQ, bad: s.bad,
    })));
    webRef.current.injectJavaScript(`window.updateShots(${json});true;`);
  }, [shots]);

  useEffect(() => {
    if (!webRef.current || !webViewReady.current) return;
    const json = JSON.stringify(shotPlan);
    webRef.current.injectJavaScript(`window.updateShotPlan(${json});true;`);
  }, [shotPlan]);

  useEffect(() => {
    if (!webRef.current) return;
    if (mapTargetPos) {
      webRef.current.injectJavaScript(`window.setTapMarker(${mapTargetPos.lat},${mapTargetPos.lon});true;`);
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
          setTapPos({ lat, lon });
          setTapLabel('');
        }
      } else if (msg.type === 'wpTap') {
        const acc = msg.hdop != null ? (msg.hdop * 1.5).toFixed(1) : '?';
        const flagLabel = msg.flagged ? 'Unflag ⚑' : 'Flag ⚑';
        Alert.alert(
          msg.label,
          `${Number(msg.lat).toFixed(6)}, ${Number(msg.lon).toFixed(6)}\n` +
          `Alt: ${Number(msg.alt).toFixed(1)} m\n` +
          `Fix: ${fixQualityName(msg.fixQ)}  ·  ~${acc} m\n` +
          `${msg.ts ? msg.ts.slice(0, 19).replace('T', ' ') : ''}`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: flagLabel, onPress: () => toggleFlag(msg.label) },
            { text: 'Delete', style: 'destructive', onPress: () => deleteWaypointByLabel(msg.label) },
          ]
        );
      } else if (msg.type === 'northLock') {
        northLockedRef.current = msg.locked;
        if (msg.locked) bearingRef.current = 0;
      } else if (msg.type === 'cacheComplete') {
        Alert.alert('Tiles cached ✓', `${msg.count} tiles downloaded for offline use.`);
      } else if (msg.type === 'cacheTooLarge') {
        Alert.alert('Area too large', `${msg.count} tiles needed. Zoom in more (cap: 1000 tiles per download).`);
      } else if (msg.type === 'cacheClear') {
        Alert.alert('Cache cleared', 'All offline map tiles deleted from this device.');
      }
    } catch {}
  };

  const pushState = () => {
    if (!webRef.current) return;
    webViewReady.current = true;
    if (gps?.fix && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)) {
      const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
      webRef.current.injectJavaScript(`window.updateGps(${gps.lat},${gps.lon},${acc},${gps.fix});true;`);
    }
    if (waypoints.length > 0) {
      const json = JSON.stringify(waypoints.map(w => ({
        lat: w.lat, lon: w.lon, alt: w.alt,
        hdop: w.hdop, fixQ: w.fixQ, ts: w.ts,
        label: w.label, flagged: flaggedLabels.has(w.label),
      })));
      webRef.current.injectJavaScript(`window.updateWaypoints(${json});true;`);
    }
    if (mapTargetPos) {
      webRef.current.injectJavaScript(`window.setTapMarker(${mapTargetPos.lat},${mapTargetPos.lon});true;`);
    }
    if (stakeoutTargets.length > 0) {
      const json = JSON.stringify(stakeoutTargets);
      webRef.current.injectJavaScript(`window.updateStakeout(${json},${stakeoutIdx});true;`);
    }
    if (predictedNextPos) {
      webRef.current.injectJavaScript(`window.updatePredicted(${predictedNextPos.lat},${predictedNextPos.lon});true;`);
    }
    if (refPoints.length > 0) {
      const json = JSON.stringify(refPoints);
      webRef.current.injectJavaScript(`window.updateRefLayer(${json});true;`);
    }
    if (shots.length > 0) {
      const json = JSON.stringify(shots.map(s => ({
        lat: s.lat, lon: s.lon, line: s.line, sp: s.sp, ts: s.ts, fixQ: s.fixQ, bad: s.bad,
      })));
      webRef.current.injectJavaScript(`window.updateShots(${json});true;`);
    }
    if (shotPlan.length > 0) {
      const json = JSON.stringify(shotPlan);
      webRef.current.injectJavaScript(`window.updateShotPlan(${json});true;`);
    }
  };

  const handleClearCache = () => {
    Alert.alert('Clear offline tiles?', 'Delete all cached map tiles from this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => webRef.current?.injectJavaScript('window.clearTileCache();true;') },
    ]);
  };

  const handleSurveyTarget = () => {
    if (!tapPos) return;
    setMapTargetPos(tapPos);
    setTapPos(null);
  };

  const handleSaveCustom = async () => {
    if (!tapPos || !tapLabel.trim()) return;
    setTapSaving(true);
    await saveWaypoint(tapLabel.trim(), tapPos.lat, tapPos.lon);
    setTapSaving(false);
    setTapPos(null);
    webRef.current?.injectJavaScript(`window.clearTapMarker();true;`);
  };

  return (
    <View style={s.container}>
      <View style={s.map}>
        <WebView
          ref={webRef}
          style={StyleSheet.absoluteFill}
          source={{ html: LEAFLET_HTML, baseUrl: 'https://localhost' }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          onLoad={pushState}
          onMessage={onMessage}
        />
        {/* Rotation overlay removed — it was swallowing ALL touch input under RN 0.85,
            leaving the map visible but completely dead. Touches now reach the WebView directly. */}
      </View>
      <TouchableOpacity style={s.clearCacheBtn} onPress={handleClearCache}>
        <Text style={s.clearCacheTxt}>🗑 Tiles</Text>
      </TouchableOpacity>

      {/* Map-tap action modal */}
      <Modal visible={!!tapPos} transparent animationType="fade" onRequestClose={() => setTapPos(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setTapPos(null)}>
          <View style={s.modalBox} onStartShouldSetResponder={() => true}>
            <Text style={s.modalCoords}>
              {tapPos ? `${tapPos.lat.toFixed(6)}, ${tapPos.lon.toFixed(6)}` : ''}
            </Text>

            {/* Option 1: send to Survey screen */}
            <TouchableOpacity style={s.optionBtn} onPress={handleSurveyTarget}>
              <Text style={s.optionIcon}>📍</Text>
              <View>
                <Text style={s.optionTitle}>Set as survey target</Text>
                <Text style={s.optionSub}>Use this position in the Survey tab for the next line:station save</Text>
              </View>
            </TouchableOpacity>

            {/* Option 2: save immediately with custom label */}
            <View style={s.divider} />
            <Text style={s.customLabel}>⚑  Save as custom marker</Text>
            <TextInput
              style={s.labelInput}
              value={tapLabel}
              onChangeText={setTapLabel}
              placeholder="e.g. HAZARD, FENCE, OLD WELL…"
              placeholderTextColor={C.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSaveCustom}
            />
            <View style={s.modalBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setTapPos(null)}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.saveBtn, (!tapLabel.trim() || tapSaving) && s.saveBtnDisabled]}
                onPress={handleSaveCustom}
                disabled={!tapLabel.trim() || tapSaving}
              >
                <Text style={s.saveTxt}>{tapSaving ? 'Saving…' : 'Save marker'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  clearCacheBtn: {
    position: 'absolute', bottom: 10, left: '50%', marginLeft: -36,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  clearCacheTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  // Map-tap modal
  modalBackdrop:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalBox:       { backgroundColor: C.card, borderRadius: 16, padding: 20, width: '100%' },
  modalCoords:    { fontSize: 11, color: C.muted, fontFamily: 'monospace', marginBottom: 14, textAlign: 'center' },
  optionBtn:      { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: C.bg, borderRadius: 10, marginBottom: 4 },
  optionIcon:     { fontSize: 24 },
  optionTitle:    { fontSize: 14, fontWeight: '700', color: C.text },
  optionSub:      { fontSize: 11, color: C.muted, marginTop: 2 },
  divider:        { height: 1, backgroundColor: C.border, marginVertical: 14 },
  customLabel:    { fontSize: 13, fontWeight: '700', color: C.accent, marginBottom: 8 },
  labelInput:     { backgroundColor: C.bg, borderRadius: 8, padding: 12, fontSize: 15, fontWeight: '700', color: C.text, borderWidth: 1, borderColor: C.border, marginBottom: 12, letterSpacing: 0.5 },
  modalBtns:      { flexDirection: 'row', gap: 10 },
  cancelBtn:      { flex: 1, padding: 13, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  cancelTxt:      { color: C.muted, fontWeight: '700', fontSize: 14 },
  saveBtn:        { flex: 1, padding: 13, borderRadius: 10, alignItems: 'center', backgroundColor: C.red },
  saveBtnDisabled:{ opacity: 0.4 },
  saveTxt:        { color: '#fff', fontWeight: '800', fontSize: 14 },
});
