import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next/**", "next-env.d.ts"] },
  // Artwork and previews are served from our own volume at fixed sizes; next/image adds nothing.
  { rules: { "@next/next/no-img-element": "off" } },
];

export default config;
