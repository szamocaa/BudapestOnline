// Sound: city ambience, footsteps, trams, buses, the metro. (Placeholder: silent.)
//
// Contract with main.js:
//   const audio = new AudioSystem();
//   audio.start();                    // called from the "Indulás" click (browsers need a gesture)
//   audio.update(frame);              // every frame, street or metro
//   audio.event(name, data)           // one-off cues: 'board', 'alight', 'metro-doors', 'encounter', 'buy', 'jump', 'land'
export class AudioSystem {
	constructor({ enabled = true } = {}) {
		this.enabled = enabled;
		this.started = false;
	}

	start() {
		this.started = true;
	}

	update(frame) {} // eslint-disable-line no-unused-vars

	event(name, data) {} // eslint-disable-line no-unused-vars
}
