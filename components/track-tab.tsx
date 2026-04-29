"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { getListingByTrackingId, type Listing } from "@/lib/listings"

export function TrackTab() {
  const [trackingId, setTrackingId] = useState("")
  const [result, setResult] = useState<Listing | null | "not-found">(null)

  const handleTrack = () => {
    if (!trackingId.trim()) return
    const found = getListingByTrackingId(trackingId)
    setResult(found ?? "not-found")
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <h2 className="text-lg font-semibold">Tracking</h2>

      <Card className="p-4 space-y-3">
        <div className="text-center space-y-1">
          <div className="text-4xl">📍</div>
          <h3 className="font-semibold">Live Tracking</h3>
          <p className="text-xs text-muted-foreground">
            Enter a tracking ID to see status
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tracking">Enter Tracking ID</Label>
          <Input
            id="tracking"
            placeholder="GYM-00012A"
            value={trackingId}
            onChange={(e) => setTrackingId(e.target.value.toUpperCase())}
            className="font-mono"
          />
        </div>

        <Button className="w-full h-11" onClick={handleTrack}>
          Track
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Tip: tracking IDs are shown on every listing
        </p>
      </Card>

      {result === "not-found" && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-900">
            No listing found with that tracking ID.
          </p>
          <p className="text-xs text-red-700 mt-1">
            v1 note: tracking IDs are visible only on the device that posted them.
            Cross-device tracking comes in v2 with the backend.
          </p>
        </Card>
      )}

      {result && result !== "not-found" && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="text-xs">
              {result.kind === "trip" ? "✈️ Trip" : "📦 Package"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {result.status}
            </Badge>
          </div>
          <div>
            <p className="font-semibold">
              {result.fromCity} → {result.toCity}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {result.kind === "package"
                ? result.description
                : result.notes || "—"}
            </p>
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <p className="text-xs text-muted-foreground">Posted by</p>
            <p className="text-sm font-medium">@{result.postedByUsername}</p>
          </div>
          <p className="text-xs text-muted-foreground italic">
            Live GPS tracking coming in v2.
          </p>
        </Card>
      )}
    </div>
  )
}
