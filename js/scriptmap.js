// Initialize the map and set its view
var map = L.map('map').setView([33.5, 44.4], 3); // Starting at Fertile Crescent (Iraq)

// Load and display map tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
}).addTo(map);

// Define locations and popups for markers
var locations = [
    { latlng: [33.5, 44.4], popup: "Fertile Crescent (10,000 BC)" },
    { latlng: [31.0461, 34.8516], popup: "Egypt (5000 BC)" },
    { latlng: [37.9838, 23.7275], popup: "Greece (3000 BC)" },
    { latlng: [41.9028, 12.4964], popup: "Rome (1000 BC)" },
    { latlng: [48.8566, 2.3522], popup: "France (500 AD)" },
    { latlng: [52.5200, 13.4050], popup: "Germany (800 AD)" },
    { latlng: [51.5074, -0.1278], popup: "United Kingdom (1066 AD)" },
    { latlng: [40.7128, -74.0060], popup: "United States (1700 AD)" }
];

// Add markers to the map
var markers = [];
locations.forEach(function(location) {
    var marker = L.marker(location.latlng).addTo(map).bindPopup(location.popup);
    markers.push(marker);

    // Show popup on hover
    marker.on('mouseover', function() {
        marker.openPopup();
    });
    marker.on('mouseout', function() {
        marker.closePopup();
    });
});

// Array to keep track of all drawn arrows (polylines)
var polylines = [];

// Function to draw an arrow (polyline) between markers and save it to the array
function drawArrow(start, end) {
    var polyline = L.polyline([start, end], {color: 'orange'}).addTo(map);
    polylines.push(polyline);
}

// Current marker index to track user's position
var currentIndex = 0;

// Function to move to the specific marker, draw an arrow, and manage popups
function moveToMarker(index) {
    if (index > currentIndex) {
        // Draw arrows and open popups for all points between currentIndex and the new index
        for (var i = currentIndex; i < index; i++) {
            drawArrow(locations[i].latlng, locations[i + 1].latlng);
            markers[i + 1].openPopup();
        }
    } else if (index < currentIndex) {
        // Remove arrows and close popups when moving backwards
        for (var i = polylines.length - 1; i >= index; i--) {
            map.removeLayer(polylines[i]);
            polylines.pop();
        }
        // Close popups after the new index
        for (var i = currentIndex; i > index; i--) {
            markers[i].closePopup();
        }
        // Open the appropriate popup for the new index
        markers[index].openPopup();
    }
    currentIndex = index;
}

// Add slider control
var slider = document.getElementById('slider');
slider.addEventListener('input', function() {
    var index = parseInt(slider.value);
    moveToMarker(index);
});

// Function to draw multiple arrows from a single point
function drawMultipleArrowsFromMarker(markerIndex) {
    var start = locations[markerIndex].latlng;
    // Draw arrows from the selected marker to multiple locations
    for (var i = markerIndex + 1; i < locations.length; i++) {
        drawArrow(start, locations[i].latlng);
    }
}

// Start by drawing multiple arrows from the first marker
drawMultipleArrowsFromMarker(0);
markers[1].openPopup();