import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SMC Terminal | Real-Time Deriv Market Data',
  description: 'Real-time Deriv WebSocket market data and Smart Money Concepts (SMC) analysis terminal',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body>{children}</body>
    </html>
  );
}
