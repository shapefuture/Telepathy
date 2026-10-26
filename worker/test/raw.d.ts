// Vite's ?raw imports (tests read migration SQL to run it against fixtures).
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
