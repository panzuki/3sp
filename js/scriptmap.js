// Initialize the map and set its view
var map = L.map('map').setView([33.5, 44.4], 3); // Starting at Fertile Crescent (Iraq)

// Load and display map tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
}).addTo(map);

// Define locations and popups for markers
var locations = [
    { latlng: [33.5, 44.4], popup: "Fertile Crescent (10,000 BC) - Origin of Wheat Cultivation" ,nextp: [1,5,6]},
    { latlng: [31.0461, 34.8516], popup: "Egypt (5000 BC) - Bread Becomes Staple Food" ,nextp: [2] },
    { latlng: [37.9838, 23.7275], popup: "Greece (3000 BC) - Wheat Spreads to the Mediterranean" ,nextp: [3] },
    { latlng: [41.9028, 12.4964], popup: "Rome (1000 BC) - Public Bakeries in the Roman Empire" ,nextp: [4]},
    { latlng: [48.8566, 2.3522], popup: "France (500 AD) - Wheat Cultivation and Bread Making Flourish",nextp: ["none"] },
    { latlng: [51.5074, -0.1278], popup: "United Kingdom (1000 AD) - Bread as a Staple for All Classes" ,nextp: ["none"] },
    { latlng: [40.7128, -74.0060], popup: "United States (1700 AD) - Wheat Cultivation Expands to the New World" ,nextp: ["none"] }
];

// Add markers to the map
var markers = [];
var slidePopups = {};
locations.forEach(function(location,index) {
//    var marker = L.marker(location.latlng).addTo(map).bindPopup(location.popup);
    var marker = L.marker(location.latlng).addTo(map);

    // Show popup on hover
    marker.on('mouseover', function() {
        if(!slidePopups[index]){
            var popup = L.popup()
                .setLatLng(location.latlng)
                .setContent(location.popup)
                .openOn(map);
            marker.bindPopup(popup);
        }
        marker.openPopup();
    });
    marker.on('mouseout', function() {
        if(!slidePopups[index]){ 
            map.closePopup();
        }
    });
    markers.push(marker);
});

var activePopups = [];

function showPopup(marker, content, index) {
    var popup = L.popup()
        .setLatLng(marker.getLatLng())
        .setContent(content)
        .openOn(map);

    slidePopups[index] = popup;
    // Add the popup to active popups list (this prevents it from being closed when another popup opens)
    activePopups.push(popup);
}

function closeAllPopups() {
    activePopups.forEach(function(popup) {
        map.closePopup(popup);
    });
    activePopups = [];  // Clear the list
}

// Array to keep track of all drawn arrows (polylines)
var polylines = [];
var layers = {};

// Function to draw an arrow (polyline) between markers and save it to the array
function drawArrow(startLatLng, endLatLng,startndex,endIndex,group) {
    var startLat = startLatLng[0];
    var startLng = startLatLng[1];
    var endLat = endLatLng[0];
    var endLng = endLatLng[1];

    // Coordinates for the right-angle path:
    // Step 1: Move horizontally first
    var midLatLng1 = [startLat, endLng]; // Move horizontally to the same longitude as the end point
    // Step 2: Move vertically
    var midLatLng2 = [endLat, endLng]; // Move vertically to the end point

    // Create the polyline path
    var path = [startLatLng, midLatLng1, midLatLng2]; // Path combining the two steps

    // Draw the polyline on the map
    var polyline = L.polyline(path, { color: 'blue', weight: 2 }).addTo(map);
    //var polyline = L.polyline([start, end], {color: 'orange'}).addTo(map);
    //polylines.push(polyline);
    layers[group].addLayer(polyline);
}

// Current marker index to track user's position
var currentIndex = 0;

// Function to move to the specific marker, draw an arrow, and manage popups
function moveToMarker(index) {
    if (index > currentIndex) {
        // Draw arrows and open popups for all points between currentIndex and the new index
        var start = locations[currentIndex].latlng;
        layers[currentIndex] = L.layerGroup();
        // console.log('Length'+locations[currentIndex].nextp.length);
        locations[currentIndex].nextp.forEach(nextpv =>{
            if (nextpv === "none") {
                
            }else{
                // console.log(locations[currentIndex].nextp[j]);
                var next = nextpv;
                drawArrow(start, locations[next].latlng, currentIndex, next, currentIndex);
                showPopup(markers[next],locations[next].popup,next)
                //markers[next].openPopup();
            }
        });
        map.addLayer(layers[currentIndex]);
    } else if (index < currentIndex) {
        // Remove arrows and close popups when moving backwards
        //for (var i = polylines.length - 1; i >= index; i--) {
         //   map.removeLayer(polylines[i]);
          //  polylines.pop();
        //}
        // Close popups after the new index
        map.removeLayer(layers[index]);
        closeAllPopups();
        if(index==0){
            showPopup(markers[0],locations[0].popup,0);
        }else{
            locations[index-1].nextp.forEach(backpv =>{
                // if (backpv === "none") {
                    // showPopup(markers[back],locations[back].popup,back)
                // }else{
                    // console.log(locations[currentIndex].nextp[j]);
                    var back = backpv;
                    showPopup(markers[back],locations[back].popup,back)
                    //markers[next].openPopup();
                // }
            });
        }
        
//        for (var i = currentIndex; i > index; i--) {
//            markers[i].closePopup();
//       }
        // Open the appropriate popup for the new index
//        markers[index].openPopup();
    }
    currentIndex = index;
}

// Add slider control
var slider = document.getElementById('slider');
slider.addEventListener('input', function() {
    var index = parseInt(slider.value);
    moveToMarker(index);
});

// Start by drawing multiple arrows from the first marker
//markers[0].openPopup();
showPopup(markers[0],locations[0].popup,0);
showPopup(markers[1],locations[1].popup,1);

document.addEventListener('keydown', function(event) {
    if (event.key === 'ArrowRight') {
        // Increase slider value (move forward)
        if (slider.value < locations.length - 1) {
            slider.value = parseInt(slider.value) + 1;
            moveToMarker(parseInt(slider.value));
        }
    } else if (event.key === 'ArrowLeft') {
        // Decrease slider value (move backward)
        if (slider.value > 0) {
            slider.value = parseInt(slider.value) - 1;
            moveToMarker(parseInt(slider.value));
        }
    }
});
