"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { UserRole } from "@/lib/pi-network"

interface AppHeaderProps {
  role: UserRole
  onRoleChange: (role: UserRole) => void
  /** Pi balance shown in header. v1: always 0 — real wallet integration in v2. */
  piBalance?: number
}

export function AppHeader({ role, onRoleChange, piBalance = 0 }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 shadow-md">
      <div className="gyema-gradient text-white">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Gyema</h1>
          <div className="rounded-full bg-white/20 backdrop-blur-sm px-3 py-1 text-sm font-semibold">
            π {piBalance.toFixed(2)}
          </div>
        </div>

        <div className="px-4 pb-3 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "flex-1 h-10 rounded-full text-sm font-medium transition-colors",
              role === "traveller"
                ? "bg-white text-foreground hover:bg-white/90"
                : "bg-white/15 text-white hover:bg-white/25"
            )}
            onClick={() => onRoleChange("traveller")}
          >
            ✈️ Traveller
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "flex-1 h-10 rounded-full text-sm font-medium transition-colors",
              role === "sender"
                ? "bg-white text-foreground hover:bg-white/90"
                : "bg-white/15 text-white hover:bg-white/25"
            )}
            onClick={() => onRoleChange("sender")}
          >
            📦 Sender
          </Button>
        </div>
      </div>

      <div className="kente-band" aria-hidden="true" />
    </header>
  )
}
