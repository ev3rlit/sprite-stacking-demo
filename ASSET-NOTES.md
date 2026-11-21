# Asset Notes

The `assets/` directory contains four-view inputs and generated assets for the taxi, inspection robot, cargo rover, ant mech, and traffic cone. The driving demo reconstructs the traffic cone from its [four-view PNG](assets/props/traffic-cone-4view.png) at runtime and reuses the model across the yard. The sources used by the demo are registered in `src/asset-catalog.json`.

The four views are ordered top, left, front, and rear. The vehicle's front points down in the top view and left in the left view. Body and wheel dimensions and mounting points are recorded in the asset catalog.

The three.js r180 MIT license notice for the Marching Cubes lookup table is included in `src/worker.js`.
