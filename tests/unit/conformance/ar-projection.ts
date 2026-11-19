/**
 * The studio's AR projection, for the conformance cases that depend on where a pixel is (fog's depth against
 * distance): NftSession's projection for a 640 × 480 video with the default planes (near 0.1, far 1000), from
 * the jsartoolkitNFT camera parameters. Column-major. tests/integration/conformance-projection.test.ts checks
 * that it still equals what the studio builds.
 */
export const AR_VIDEO = { width: 640, height: 480 };

// prettier-ignore
export const AR_PROJECTION: readonly number[] = [
  1.9102363924347978, 0, 0, 0,
  0, 2.5377457054523322, 0, 0,
  -0.013943280545895442, -0.005830389685211879, -1.0002000200020003, -1,
  0, 0, -0.20002000200020004, 0,
];
