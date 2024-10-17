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
    console.log('index'+index);
    if (index > currentIndex) {
        // Draw arrows and open popups for all points between currentIndex and the new index
    var start = locations[currentIndex].latlng;
    // Draw arrows from the selected marker to multiple locations
        var start = locations[currentIndex].latlng;
        // Draw arrows from the selected marker to multiple locations
        for (var j = 0 ; j <= locations[currentIndex].nextp.length; j++) {
            console.log('Length'+locations[currentIndex].nextp.length);
            if (locations[currentIndex].nextp[j] == "none") {
                
            }else{
                console.log('j='+j);
                console.log(locations[currentIndex].nextp[j]);
                var next = locations[currentIndex].nextp[j];
                                console.log(start);
                                console.log(locations[next].latlng);
                drawArrow(start, locations[next].latlng);
                markers[locations[index].nextp[j]].openPopup();
            }
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



// Start by drawing multiple arrows from the first marker
markers[0].openPopup();

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
