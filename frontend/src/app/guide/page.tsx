"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, HelpCircle } from "lucide-react";

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-ivory-100 flex flex-col font-sans">
      <header className="bg-forest-900 text-ivory-100 px-6 py-4 flex items-center justify-between border-b border-forest-800 shadow-sm sticky top-0 z-50">
        <div className="flex items-center space-x-3">
          <Link
            href="/integrations"
            className="flex items-center space-x-2 text-ivory-300 hover:text-white transition-colors text-sm font-semibold py-1 px-2 rounded-lg hover:bg-forest-800"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Integrations</span>
          </Link>
          <span className="text-forest-700">|</span>
          <div className="flex items-center space-x-2">
            <HelpCircle className="w-5 h-5 text-terracotta-400" />
            <h1 className="text-base font-bold text-white">API Integration Guide & FAQs</h1>
          </div>
        </div>

        <a
          href="/guide.html"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center space-x-1.5 text-xs text-terracotta-400 hover:text-terracotta-300 font-semibold py-1 px-3 rounded-lg border border-terracotta-500/30 hover:bg-terracotta-500/10 transition-colors"
        >
          <span>Open Fullscreen</span>
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </header>

      <main className="flex-1 w-full flex">
        <iframe
          src="/guide.html"
          title="125East API Setup & FAQ Guide"
          className="w-full flex-1 border-0 min-h-[calc(100vh-60px)]"
        />
      </main>
    </div>
  );
}
