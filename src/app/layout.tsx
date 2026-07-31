import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "IDP — Intelligent Document Processing",
  description: "Textract + Claude on Bedrock document pipeline with human review",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="app">
            <h1>
              <Link href="/" style={{ color: "inherit" }}>
                Intelligent Document Processing
              </Link>
            </h1>
            <span className="sub">Textract → Claude on Bedrock → human review</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
