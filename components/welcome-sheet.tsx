"use client"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

interface WelcomeSheetProps {
  onDismiss: () => void
}

export function WelcomeSheet({ onDismiss }: WelcomeSheetProps) {
  return (
    <Sheet open onOpenChange={onDismiss}>
      <SheetContent side="bottom" className="rounded-t-2xl px-5 pb-6 pt-4">
        <SheetHeader className="text-center space-y-1 pb-3">
          <SheetTitle className="text-xl text-center">
            👋 Welcome to Gyema
          </SheetTitle>
          <p className="text-sm text-muted-foreground text-center">
            P2P delivery on Pi Network
          </p>
        </SheetHeader>

        <div className="space-y-4 pt-2">
          <section className="flex gap-3">
            <div className="text-2xl shrink-0">✈️</div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Traveller mode</p>
              <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                Accept delivery jobs on routes you're already taking. Earn Pi
                for trips you'd make anyway.
              </p>
            </div>
          </section>

          <section className="flex gap-3">
            <div className="text-2xl shrink-0">📦</div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Sender mode</p>
              <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                Post packages and connect with travellers. Coordinate
                pickup, dropoff, and Pi payment via WhatsApp.
              </p>
            </div>
          </section>

          <section className="flex gap-3">
            <div className="text-2xl shrink-0">⚠️</div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Stay safe</p>
              <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                Gyema connects users — payments and coordination happen on
                WhatsApp. Verify identity via Pi KYC before sending
                valuables.
              </p>
            </div>
          </section>

          <Button
            onClick={onDismiss}
            className="w-full h-11 font-semibold mt-2"
          >
            Got it
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
