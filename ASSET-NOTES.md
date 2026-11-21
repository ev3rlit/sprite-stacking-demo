# Asset Notes

The `assets/` directory contains four-view inputs and generated assets for the taxi, inspection robot, cargo rover, ant mech, and armored miniature. The demo reconstructs the traffic cone, wet-floor sign, plastic barrier, and concrete barrier from the original four-view PNGs in `assets/props/`. The model sources and prop settings are registered in `src/asset-catalog.json`.

The tank hull, turret, and track are independent four-view assets in `assets/tank/`. Both tracks share one reconstructed model.

The four views are ordered top, left, front, and rear. The vehicle's front points down in the top view and left in the left view. Body and wheel dimensions and mounting points are recorded in the asset catalog.

The three.js r180 MIT license notice for the Marching Cubes lookup table is included in `src/worker.js`.
