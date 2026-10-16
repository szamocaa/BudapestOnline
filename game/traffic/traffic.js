// Cars: parked along the kerbs and driving on the streets. (Placeholder: no cars yet.)
//
// Contract with main.js:
//   const traffic = new Traffic(scene, city, world, { quality });
//   traffic.update(frame);            // every frame on the street
//   traffic.blocksPlayer?(x, z, r)    // optional: collision with cars
export class Traffic {
	constructor(scene, city, world, { quality = 'high' } = {}) {
		this.scene = scene;
		this.city = city;
		this.world = world;
		this.quality = quality;
		this.count = 0;
	}

	update(frame) {} // eslint-disable-line no-unused-vars
}
