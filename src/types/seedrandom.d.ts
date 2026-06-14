declare module "seedrandom" {
  type SeedRandom = () => number;
  function seedrandom(seed?: string): SeedRandom;
  export default seedrandom;
}
