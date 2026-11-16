"use client";

import { isDesktopApp } from "@/lib/save";

type Props = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/**
 * Enlace a una página externa.
 * - Navegador: abre una pestaña nueva, como siempre.
 * - App de escritorio: lo abre en el navegador predeterminado de Windows
 *   (la ventana de Tauri no abre páginas externas por seguridad).
 */
export function ExternalLink({ href, children, onClick, ...rest }: Props) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={async (e) => {
        onClick?.(e);
        if (!isDesktopApp()) return;
        e.preventDefault();
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
