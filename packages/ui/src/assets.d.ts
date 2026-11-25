// Vite turns image imports into URLs (web, extension and desktop all build with Vite).
declare module "*.png" {
  const src: string;
  export default src;
}
