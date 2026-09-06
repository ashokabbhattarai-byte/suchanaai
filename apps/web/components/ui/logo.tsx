"use client"

import React from "react"
import Link from "next/link"
import Image from "next/image"
import logo from "@/public/images/logo.png"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  href?: string
  className?: string
  invert?: boolean
}

const heights = {
  sm: "h-10",
  md: "h-14",
  lg: "h-18",
}

export function Logo({ size = "md", href = "/", className = "", invert = false }: LogoProps) {
  const inner = (
    <Image
      src={logo}
      alt="Suchana AI"
      placeholder="blur"
      draggable={false}
      className={`${heights[size]} w-auto ${invert ? "brightness-0 invert" : ""} ${className}`}
    />
  )

  if (!href) return inner
  return (
    <Link href={href} className="inline-flex shrink-0 items-center transition-opacity hover:opacity-80">
      {inner}
    </Link>
  )
}
