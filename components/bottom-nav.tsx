"use client"

import { cn } from "@/lib/utils"

export type Tab = "home" | "trips" | "track" | "profile"

interface BottomNavProps {
  active: Tab
  onChange: (tab: Tab) => void
}

const tabs: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "home", icon: "🏠", label: "Home" },
  { id: "trips", icon: "✈️", label: "My Trips" },
  { id: "track", icon: "📍", label: "Track" },
  { id: "profile", icon: "👤", label: "Profile" },
]

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-card border-t safe-bottom z-20">
      <div className="max-w-md mx-auto flex items-center justify-around px-2 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg transition-colors min-w-16",
              active === tab.id
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="text-xl">{tab.icon}</span>
            <span className="text-[11px] font-medium">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
