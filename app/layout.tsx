import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Mini-C Compiler Visualizer',
  description:
    'Explore how a small C-like program moves through lexical analysis, parsing, semantic analysis, LLVM-style intermediate representation, assembly and execution.',
};

/**
 * Runs before first paint: reads the stored theme (or system preference) and
 * sets `.dark` + color-scheme on <html> so there is no flash of the wrong
 * theme. Never runs during server render (it only touches window/localStorage).
 */
const themeScript = `(function(){try{var c=localStorage.getItem('minic-theme');if(c!=='light'&&c!=='dark'&&c!=='system')c='system';var d=c==='dark'||(c==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full bg-background text-foreground">{children}</body>
    </html>
  );
}
