// Rainviewer plugin for Leaflet — animated radar overlay with playback controls.
// Source: https://github.com/mwasil/Leaflet.Rainviewer — NOT rainviewer/rainviewer-api-example
// as previously (incorrectly) cited here. Neither repo publishes a license;
// see LICENSE.md's "Third-Party Software Notices" for the unresolved status.
// Modified for use in a Vite/ESM bundle: added explicit Leaflet import at the top
// so the plugin doesn't depend on `L` being a global.

import L from 'leaflet'

L.Control.Rainviewer = L.Control.extend({
    options: {
        position: 'bottomleft',
        nextButtonText: '>',
        playStopButtonText: 'Play/Stop',
        prevButtonText: '<',
        positionSliderLabelText: "Hour:",
        opacitySliderLabelText: "Opacity:",
        animationInterval: 500,
        opacity: 0.5
    },

    onAdd: function (map) {
        /**
         * RainViewer radar animation part
         * @type {number[]}
         */
        this.timestamps = [];
        this.radarLayers = [];

        this.currentTimestamp;
        this.nextTimestamp;

        this.animationPosition = 0;
        this.animationTimer = false;

        this.rainviewerActive = false;

        this._map = map;

        this.container = L.DomUtil.create('div', 'leaflet-control-rainviewer leaflet-bar leaflet-control');

        this.link = L.DomUtil.create('a', 'leaflet-control-rainviewer-button leaflet-bar-part', this.container);
        this.link.href = '#';
        this.link.title = 'Toggle radar animation';
        this.link.innerHTML = '<span class="leaflet-control-rainviewer-icon"></span><span class="leaflet-control-rainviewer-label">Weather Radar</span>';
        L.DomEvent.on(this.link, 'click', this.toggle, this);
        return this.container;

        /*return this.load(map);*/


    },

    // Toggle the controls panel and radar layers on/off. Without this, every
    // icon click re-runs load() and appends another set of controls.
    toggle: function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        if (L.DomUtil.hasClass(this.container, 'leaflet-control-rainviewer-active')) {
            this.stop();
            this.unload(e);
        } else {
            this.load(e);
        }
    },

    load: function(map) {
                /**
         * Load actual radar animation frames this.timestamps from RainViewer API
         */
		var t = this;
        this.apiRequest = new XMLHttpRequest();
        this.apiRequest.open("GET", "https://api.rainviewer.com/public/weather-maps.json", true);
        this.apiRequest.onload = function (e) {
            try {
                var data = JSON.parse(t.apiRequest.response);
                // Current Rainviewer API returns a structured object instead
                // of the flat array the original plugin expected. We flatten
                // past + nowcast radar frames and keep their per-frame paths.
                var frames = (data.radar && data.radar.past ? data.radar.past : [])
                    .concat(data.radar && data.radar.nowcast ? data.radar.nowcast : []);
                t.timestamps = frames.map(function (f) { return f.time; });
                t.framesByTime = {};
                frames.forEach(function (f) { t.framesByTime[f.time] = f; });
                t.host = data.host || "https://tilecache.rainviewer.com";
                if (t.timestamps.length > 0) {
                    t.showFrame(-1);
                }
            } catch (err) {
                console.error("Rainviewer: failed to load animation frames", err);
            }
        };
        this.apiRequest.send();

        /**
         * Animation functions
         * @param ts
         */

        L.DomUtil.addClass(this.container, 'leaflet-control-rainviewer-active');

        this.controlContainer = L.DomUtil.create('div', 'leaflet-control-rainviewer-container', this.container);

        // [WeatherMap mod] Wrap the 3 transport buttons in a row container so
        // CSS grid in App.css can place slider rows directly next to their
        // labels (no empty column under the buttons).
        this.buttonsRow = L.DomUtil.create('div', 'leaflet-control-rainviewer-buttons', this.controlContainer);

        this.prevButton = L.DomUtil.create('input', 'leaflet-control-rainviewer-prev leaflet-bar-part btn', this.buttonsRow);
        this.prevButton.type = "button";
        this.prevButton.value = this.options.prevButtonText;
        L.DomEvent.on(this.prevButton, 'click', t.prev, this);
        L.DomEvent.disableClickPropagation(this.prevButton);

        this.startstopButton = L.DomUtil.create('input', 'leaflet-control-rainviewer-startstop leaflet-bar-part btn', this.buttonsRow);
        this.startstopButton.type = "button";
        this.startstopButton.value = this.options.playStopButtonText;
        L.DomEvent.on(this.startstopButton, 'click', t.startstop, this);
        L.DomEvent.disableClickPropagation(this.startstopButton);

        this.nextButton = L.DomUtil.create('input', 'leaflet-control-rainviewer-next leaflet-bar-part btn', this.buttonsRow);
        this.nextButton.type = "button";
        this.nextButton.value = this.options.nextButtonText;
        L.DomEvent.on(this.nextButton, 'click', t.next, this);
        L.DomEvent.disableClickPropagation(this.nextButton);

        this.positionSliderLabel = L.DomUtil.create('label', 'leaflet-control-rainviewer-label leaflet-bar-part', this.controlContainer);
        this.positionSliderLabel.for = "rainviewer-positionslider";
        this.positionSliderLabel.textContent = this.options.positionSliderLabelText;

        this.positionSlider = L.DomUtil.create('input', 'leaflet-control-rainviewer-positionslider leaflet-bar-part', this.controlContainer);
        this.positionSlider.type = "range";
        this.positionSlider.id = "rainviewer-positionslider";
        this.positionSlider.min = 0;
        this.positionSlider.max = 11;
        this.positionSlider.value = this.animationPosition;
        L.DomEvent.on(this.positionSlider, 'input', t.setPosition, this);
        L.DomEvent.disableClickPropagation(this.positionSlider);

        this.opacitySliderLabel = L.DomUtil.create('label', 'leaflet-control-rainviewer-label leaflet-bar-part', this.controlContainer);
        this.opacitySliderLabel.for = "rainviewer-opacityslider";
        this.opacitySliderLabel.textContent = this.options.opacitySliderLabelText;

        this.opacitySlider = L.DomUtil.create('input', 'leaflet-control-rainviewer-opacityslider leaflet-bar-part', this.controlContainer);
        this.opacitySlider.type = "range";
        this.opacitySlider.id = "rainviewer-opacityslider";
        this.opacitySlider.min = 0;
        this.opacitySlider.max = 100;
        this.opacitySlider.value = this.options.opacity*100;
        L.DomEvent.on(this.opacitySlider, 'input', t.setOpacity, this);
        L.DomEvent.disableClickPropagation(this.opacitySlider);


        this.closeButton = L.DomUtil.create('div', 'leaflet-control-rainviewer-close', this.container);
        L.DomEvent.on(this.closeButton, 'click', t.unload, this);

        var html = '<div id="timestamp" class="leaflet-control-rainviewer-timestamp"></div>'

        this.controlContainer.insertAdjacentHTML('beforeend', html);

        L.DomEvent.disableClickPropagation(this.controlContainer);

        /*return container;*/
    },

    unload: function(e) {
        //console.log("Executing Rainviewer unload() method....", e);

        try {

        L.DomUtil.remove(this.controlContainer);
        L.DomUtil.remove(this.closeButton);
        L.DomUtil.removeClass(this.container, 'leaflet-control-rainviewer-active');
        //console.log(this.radarLayers);
        var radarLayers = this.radarLayers;
        var map = this._map;
        Object.keys(radarLayers).forEach(function (key) {
            if (map.hasLayer(radarLayers[key])) {
                map.removeLayer(radarLayers[key]);
            }
         });

        }
        catch(err) {
          this.unload(e);
        }
    },
    
    addLayer: function(ts) {
        var map = this._map;
        if (!this.radarLayers[ts]) {
            // Build the tile URL from the host + per-frame path that the
            // current Rainviewer API provides. Falls back to the old pattern
            // (constructed from timestamp) if the frame metadata is missing,
            // so the layer still attempts to render rather than throwing.
            var frame = this.framesByTime && this.framesByTime[ts];
            var url = frame
                ? this.host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png'
                : (this.host || 'https://tilecache.rainviewer.com') + '/v2/radar/' + ts + '/256/{z}/{x}/{y}/2/1_1.png';
            this.radarLayers[ts] = new L.TileLayer(url, {
                tileSize: 256,
                opacity: 0.001,
				transparent: true,
				attribution: 'Weather data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>',
                zIndex: ts
            });
        }
        if (!map.hasLayer(this.radarLayers[ts])) {
            map.addLayer(this.radarLayers[ts]);
        }
    },

    /**
     * Display particular frame of animation for the @position
     * If preloadOnly parameter is set to true, the frame layer only adds for the tiles preloading purpose
     * @param position
     * @param preloadOnly
     */
    changeRadarPosition: function(position, preloadOnly) {

        // Defensive guard: bail out if the timestamps API call hasn't returned
        // (or returned empty). Without this check, the while loops below become
        // infinite when this.timestamps.length === 0, locking the main thread.
        if (!this.timestamps || this.timestamps.length === 0) {
            return;
        }

        while (position >= this.timestamps.length) {
            position -= this.timestamps.length;
        }
        while (position < 0) {
            position += this.timestamps.length;
        }

        this.currentTimestamp = this.timestamps[this.animationPosition];
        this.nextTimestamp = this.timestamps[position];

        this.addLayer(this.nextTimestamp);

        if (preloadOnly) {
            return;
        }

        this.animationPosition = position;
        this.positionSlider.value = position;

        if (this.radarLayers[this.currentTimestamp]) {
            this.radarLayers[this.currentTimestamp].setOpacity(0);
        }
        this.radarLayers[this.nextTimestamp].setOpacity(this.options.opacity);

        document.getElementById("timestamp").innerHTML = (new Date(this.nextTimestamp * 1000)).toLocaleString();
    },

    /**
     * Check avialability and show particular frame position from the this.timestamps list
     */
    showFrame: function(nextPosition) {
        var preloadingDirection = nextPosition - this.animationPosition > 0 ? 1 : -1;

        this.changeRadarPosition(nextPosition);

        // preload next next frame (typically, +1 frame)
        // if don't do that, the animation will be blinking at the first loop
        this.changeRadarPosition(nextPosition + preloadingDirection, true);
    },

    /**
     * Stop the animation
     * Check if the animation timeout is set and clear it.
     */
    setOpacity: function(e){
        //console.log(e.srcElement.value/100);
        if (this.radarLayers[this.currentTimestamp]) {
            this.radarLayers[this.currentTimestamp].setOpacity(e.srcElement.value/100);
        }
    },

    setPosition: function(e){
        this.showFrame(e.srcElement.value)
    },

    stop: function() {
        //console.log("Executing Rainviewer stop() method....");
        if (this.animationTimer) {
            clearTimeout(this.animationTimer);
            this.animationTimer = false;
            return true;
        }
        return false;
    },

    play: function() {
        // Don't start animating if timestamps haven't loaded yet — otherwise
        // we'd schedule a setTimeout chain that does nothing useful and races
        // against the XHR completion.
        if (!this.timestamps || this.timestamps.length === 0) {
            return;
        }
        this.showFrame(this.animationPosition + 1);

        // Main animation driver. Run this function every 500 ms
        this.animationTimer = setTimeout(function(){ this.play() }.bind(this), this.options.animationInterval);
    },

    playStop: function() {
        //console.log("Executing Rainviewer playStop() method....");

        if (!this.stop()) {
           this.play();
        }
    },

    prev: function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        this.stop();
        this.showFrame(this.animationPosition - 1);
        return
    },

    startstop: function(e) {
        //console.log("Executing Rainviewer startstop() method....", e);

        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        this.playStop()

    },

    next: function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        this.stop();
        this.showFrame(this.animationPosition + 1);
        return
    },

    onRemove: function (map) {
        // Nothing to do here
    }
});

L.control.rainviewer = function (opts) {
    return new L.Control.Rainviewer(opts);
}