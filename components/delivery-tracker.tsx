"use client"

import { type Listing } from "@/lib/listings"
import { type GuestJobView } from "@/lib/guest-jobs"
import { deriveGuestStages, deriveStages, type Stage } from "@/lib/tracker-stages"

const FOREST = "#15803D"
const GOLD = "#F5B800"
const VERMILLION = "#DC2626"

function nodeColor(state: Stage["state"]): string {
  if (state === "done") return FOREST
  if (state === "current") return GOLD
  if (state === "cancelled") return VERMILLION
  return "#D6D3D1"
}

export function DeliveryTracker({ listing }: { listing: Listing | GuestJobView }) {
  const isGuest = listing.kind === "guest"
  const stages = isGuest ? deriveGuestStages(listing) : deriveStages(listing)
  const fromLabel = isGuest ? listing.pickupArea : listing.fromCity
  const toLabel = isGuest ? listing.dropoffArea : listing.toCity
  const doneCount = stages.filter((st) => st.state === "done").length
  const currentIdx = stages.findIndex((st) => st.state === "current")
  const filled = currentIdx >= 0 ? currentIdx + 0.5 : doneCount
  const pct = Math.max(0, Math.min(100, (filled / (stages.length - 1)) * 100))

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="font-semibold text-base">
          {fromLabel} {"\u2192"} {toLabel}
        </p>
        <div className="relative h-1.5 w-full rounded-full bg-stone-200">
          <div
            className="absolute left-0 top-0 h-1.5 rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: GOLD }}
          />
        </div>
        <div className="flex justify-between">
          <span className="text-[10px] font-mono text-muted-foreground">{fromLabel}</span>
          <span className="text-[10px] font-mono text-muted-foreground">{toLabel}</span>
        </div>
      </div>

      <div>
        {stages.map((st, i) => {
          const color = nodeColor(st.state)
          const isLast = i === stages.length - 1
          return (
            <div key={st.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className="h-4 w-4 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor: st.state === "upcoming" ? "transparent" : color,
                    border: st.state === "upcoming" ? `2px solid ${color}` : "none",
                    boxShadow: st.state === "current" ? `0 0 0 4px ${GOLD}33` : "none",
                  }}
                >
                  {st.state === "done" && (
                    <span className="text-white text-[10px] leading-none">{"\u2713"}</span>
                  )}
                </div>
                {!isLast && (
                  <div
                    className="w-0.5 flex-1"
                    style={{ backgroundColor: st.state === "done" ? FOREST : "#E7E5E4", minHeight: "1.5rem" }}
                  />
                )}
              </div>
              <div className="pb-4">
                <p className="text-sm font-medium leading-tight" style={{ opacity: st.state === "upcoming" ? 0.5 : 1 }}>
                  {st.label}
                </p>
                <p className="text-xs font-mono mt-0.5 text-muted-foreground" style={{ opacity: st.state === "upcoming" ? 0.5 : 1 }}>
                  {st.caption}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}