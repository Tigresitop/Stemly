import { Geist, JetBrains_Mono } from "next/font/google";

// Fuente de interfaz
export const sans = Geist({ subsets: ["latin"], variable: "--font-stemly-sans" });

// Fuente "de consola" para etiquetas, tiempos y numeros
export const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-stemly-mono" });
