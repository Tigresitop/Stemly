import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Genera la interfaz como archivos estáticos (carpeta out/) para que Tauri
  // la muestre dentro de la ventana de escritorio, sin servidor de Node.
  output: "export",
  images: { unoptimized: true },

  // Tailwind CSS: procesa los .css con el plugin de Turbopack (no borrar).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
