/* Shared delivery map. Coordinates remain internal; only explicit pin changes are emitted. */
(function () {
  var map = L.map('map').setView([30.0444, 31.2357], 13), marker;
  new ResizeObserver(function(){map.invalidateSize();}).observe(document.getElementById('map'));
  var status = document.getElementById('status');
  var ar = new URLSearchParams(location.search).get('locale') === 'ar';
  function emit(value) {
    var payload = JSON.stringify(value);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(payload);
    else if (window.DeliveryMap) window.DeliveryMap.postMessage(payload);
    else window.parent.postMessage(value, location.origin);
  }
  var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
  }).addTo(map);
  tiles.on('tileerror', function () { status.textContent = ar ? 'تعذر تحميل الخريطة. تحقق من اتصالك.' : 'Map unavailable. Check your connection.'; });
  tiles.on('tileload', function () { status.textContent = ''; });
  var icon = L.divIcon({className:'delivery-pin',html:'<span></span>',iconSize:[32,42],iconAnchor:[16,42]});
  function valid(lat, lon) { return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=85 && Math.abs(lon)<=180; }
  function select(lat, lon, notify, center) {
    if (!valid(lat,lon)) return;
    if (!marker) {
      marker=L.marker([lat,lon],{draggable:true,icon:icon,title:ar?'موقع التوصيل':'Delivery pin',autoPan:true}).addTo(map);
      marker.on('dragend',function(){var p=marker.getLatLng();emit({type:'pin',latitude:p.lat,longitude:p.lng});});
    } else marker.setLatLng([lat,lon]);
    if (center) map.setView([lat,lon],Math.max(map.getZoom(),16));
    if (notify) emit({type:'pin',latitude:lat,longitude:lon});
  }
  map.on('click',function(e){select(e.latlng.lat,e.latlng.lng,true,false);});
  window.setDeliveryPin=function(lat,lon){select(lat,lon,false,true);};
  window.addEventListener('message',function(e){if(e.origin!==location.origin || e.source!==window.parent)return;var p=e.data;if(p&&p.type==='set-pin')select(p.latitude,p.longitude,false,true);});
  emit({type:'ready'});
})();
