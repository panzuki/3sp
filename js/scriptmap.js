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
    { latlng: [48.8566, 2.3522], popup: "France (500 AD)" }
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

// Function to draw an arrow (polyline) between markers
var polyline;
function drawArrow(start, end) {
    if (polyline) {
        map.removeLayer(polyline);  // Remove previous arrow
    }
    polyline = L.polyline([start, end], {color: 'orange'}).addTo(map);
}

// Current marker index to track user's position
var currentIndex = 0;

// Function to move to the specific marker and draw an arrow
function moveToMarker(index) {
    if (index >= 0 && index < locations.length - 1) {
        drawArrow(locations[index].latlng, locations[index + 1].latlng);
        markers[index + 1].openPopup();
        currentIndex = index;
    }
}

// Listen for arrow key presses
document.addEventListener('keydown', function(event) {
    if (event.key === 'ArrowRight') {
        moveToMarker(currentIndex + 1);  // Move to the next marker on right arrow
    } else if (event.key === 'ArrowLeft') {
        moveToMarker(currentIndex - 1);  // Move to the previous marker on left arrow
    }
});

// Add slider control
var slider = document.getElementById('slider');
slider.addEventListener('input', function() {
    var index = parseInt(slider.value);
    moveToMarker(index);
});

// Start by drawing the first arrow
drawArrow(locations[0].latlng, locations[1].latlng);
markers[1].openPopup();
