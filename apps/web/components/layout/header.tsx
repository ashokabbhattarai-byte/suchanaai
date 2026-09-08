"use client"

import React, { useState, useEffect, useRef } from "react"
import Link from "next/link"
import Image from "next/image"
import logo from "@/public/images/logo.png"
import { usePathname } from "next/navigation"
import { Bell, Menu, X, Globe, LogOut, LayoutDashboard, Shield, ArrowUpRight, ChevronDown } from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { useLanguage } from "@/lib/language-context"
import { cn } from "@/lib/utils"

const productLinks = [
  { id: "#problem", tKey: "nav.product.problem" },
  { id: "#solution", tKey: "nav.product.solution" },
  { id: "#features", tKey: "nav.product.features" },
]

const resourceLinks = [
  { href: "/notices", tKey: "nav.notices" },
  { href: "/documents", tKey: "nav.rag" },
]

const standaloneLinks = [
  { id: "#pricing", tKey: "nav.pricing", anchor: true },
  { href: "/about", tKey: "nav.about", anchor: false },
]

function Dropdown({ label, children, solid }: { label: string; children: React.ReactNode; solid: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 sm:gap-1.5 whitespace-nowrap rounded-full px-3 sm:px-4 py-1.5 text-sm sm:text-base font-poppins tracking-tight leading-none transition-colors min-h-[44px] sm:min-h-0",
          "text-vez-ink hover:bg-white/60"
        )}
      >
        {label}
        <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div className={cn(
          "absolute top-full left-0 mt-2 min-w-[160px] max-w-[95vw] rounded-xl sm:rounded-2xl border p-1.5 shadow-lg backdrop-blur-xl",
          solid ? "bg-white/90 border-white/60" : "bg-white/80 border-white/40"
        )}>
          {children}
        </div>
      )}
    </div>
  )
}

export function Header() {
  const { user, logout } = useAuth()
  const { language, setLanguage, t } = useLanguage()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const isHome = pathname === "/"
  const solid = !isHome || scrolled || mobileOpen

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string, anchor: boolean) => {
    if (anchor && isHome && href.startsWith("#")) {
      e.preventDefault()
      const element = document.querySelector(href)
      if (element) {
        const top = element.getBoundingClientRect().top + window.pageYOffset - 88
        window.scrollTo({ top, behavior: "smooth" })
      }
    }
    setMobileOpen(false)
  }


  const isActive = (href: string, anchor: boolean) =>
    !anchor && pathname === href

  return (
    <>
      <header
        className={cn(
          "fixed top-0 left-0 right-0 z-50 w-full transition-all duration-300 [padding-top:env(safe-area-inset-top)]",
          solid
            ? "bg-white/60 backdrop-blur-xl border-b border-white/50 shadow-sm"
            : "bg-transparent"
        )}
      >
        <div className="mx-auto flex h-16 sm:h-20 max-w-7xl items-center justify-between gap-2 sm:gap-3 xl:gap-4 px-4 sm:px-6 lg:px-8">
          {/* Brand - responsive sizing to prevent overflow on 375px */}
          <Link href="/" className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2 rounded-lg min-h-[44px] flex items-center">
            <Image
              src={logo}
              alt="Suchana AI"
              width={220}
              height={220}
              className="h-9 sm:h-12 md:h-14 lg:h-16 xl:h-[68px] w-auto max-w-[120px] sm:max-w-[140px] lg:max-w-none object-contain"
              priority
            />
            <span className="sr-only text-lg sm:text-xl font-poppins tracking-tight">Suchana AI</span>
          </Link>

          {/* Frosted pill nav - desktop only, single row to prevent wrap/overlap with ticker */}
          <nav
            className={cn(
              "hidden xl:flex items-center gap-1 xl:gap-2 rounded-full p-1 xl:p-1.5 backdrop-blur-md border transition-all duration-300 font-poppins tracking-tight shrink-0",
              solid ? "bg-white/40 border-white/50" : "bg-white/10 border-white/20"
            )}
          >
            <Dropdown label={t("nav.product")} solid={solid}>
              {productLinks.map((link) => (
                <Link
                  key={link.tKey}
                  href={isHome ? link.id : `/${link.id}`}
                  onClick={(e) => handleNavClick(e, isHome ? link.id : `/${link.id}`, true)}
                  className="block rounded-lg px-3 py-2 text-base text-vez-ink transition-colors hover:bg-vez-sky/40"
                >
                  {t(link.tKey)}
                </Link>
              ))}
            </Dropdown>

            {resourceLinks.map((link) => (
              <Link
                key={link.tKey}
                href={link.href}
                className={cn(
                  "whitespace-nowrap rounded-full px-3 sm:px-4 py-1.5 text-sm sm:text-base font-poppins tracking-tight leading-none transition-colors min-h-[44px] sm:min-h-0 flex items-center",
                  isActive(link.href, false)
                    ? "bg-vez-navy text-white"
                    : "text-vez-ink hover:bg-white/60"
                )}
              >
                {t(link.tKey)}
              </Link>
            ))}

            {standaloneLinks.map((link) => {
              const href = link.anchor ? (isHome ? link.id! : `/${link.id}`) : link.href!
              return (
                <Link
                  key={link.tKey}
                  href={href}
                  onClick={(e) => handleNavClick(e, href, link.anchor)}
                  className={cn(
                    "whitespace-nowrap rounded-full px-3 sm:px-4 py-1.5 text-sm sm:text-base font-poppins tracking-tight leading-none transition-colors min-h-[44px] sm:min-h-0 flex items-center",
                    isActive(href, link.anchor)
                      ? "bg-vez-navy text-white"
                      : "text-vez-ink hover:bg-white/60"
                  )}
                >
                  {t(link.tKey)}
                </Link>
              )
            })}
          </nav>

          {/* Right actions - desktop only, single row */}
          <div className="hidden xl:flex items-center gap-2 xl:gap-3 shrink-0">
            <Link
              href="/contact"
              className={cn(
                "flex items-center gap-1.5 rounded-full px-4 sm:px-5 py-2 text-sm sm:text-base font-medium font-poppins tracking-tight transition-all min-h-[44px] sm:min-h-0",
                pathname === "/contact"
                  ? "bg-vez-navy text-white"
                  : "bg-vez-navy/10 text-vez-navy border border-vez-navy/10 hover:bg-vez-navy hover:text-white hover:border-vez-navy"
              )}
            >
              {t("nav.contact")}
              <ArrowUpRight className="size-3.5" />
            </Link>

            <button
              onClick={() => setLanguage(language === "en" ? "ne" : "en")}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm sm:text-base font-poppins tracking-tight text-vez-ink transition-colors hover:bg-white/60 min-h-[44px] sm:min-h-0"
            >
              <Globe className="size-4" />
              {language === "en" ? "EN" : "ने"}
            </button>

            {user ? (
              <>
                <button
                  className={cn(
                    "relative flex size-10 items-center justify-center rounded-full text-vez-ink/70 transition-colors hover:text-vez-navy",
                    solid ? "hover:bg-vez-surface" : "hover:bg-white/40"
                  )}
                  aria-label="Notifications"
                >
                  <Bell className="size-4" />
                  <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-vez-navy text-[9px] text-white">
                    3
                  </span>
                </button>

                {user.role === "admin" && (
                  <Link
                    href="/admin"
                    className={cn(
                      "flex size-10 items-center justify-center rounded-full text-vez-ink/70 transition-colors hover:text-vez-navy",
                      solid ? "hover:bg-vez-surface" : "hover:bg-white/40"
                    )}
                    aria-label="Admin panel"
                  >
                    <Shield className="size-4" />
                  </Link>
                )}

                <Link
                  href="/dashboard"
                  className="flex items-center gap-1.5 rounded-full bg-vez-navy px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base font-poppins tracking-tight text-white transition-opacity hover:opacity-90 min-h-[44px]"
                >
                  <LayoutDashboard className="size-4" />
                  {t("nav.dashboard")}
                </Link>

                <div className="ml-1 flex items-center gap-2 border-l border-vez-ink/15 pl-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-vez-sky">
                    <span className="text-sm text-vez-navy">{user.username[0].toUpperCase()}</span>
                  </div>
                  <button
                    onClick={logout}
                    className="flex size-9 items-center justify-center rounded-full text-vez-ink/60 transition-colors hover:bg-red-50 hover:text-red-600"
                    aria-label="Sign out"
                  >
                    <LogOut className="size-4" />
                  </button>
                </div>
              </>
            ) : (
              <Link
                href="/login"
                className="flex items-center gap-1.5 rounded-full bg-vez-navy px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base font-poppins tracking-tight text-white transition-opacity hover:opacity-90 min-h-[44px]"
              >
                {t("nav.signin")}
                <ArrowUpRight className="size-4" />
              </Link>
            )}
          </div>

          {/* Mobile toggle - 44px touch targets, 8px gap */}
          <div className="flex items-center gap-2 xl:hidden shrink-0">
            {user && (
              <button className="relative flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/40 text-vez-ink backdrop-blur-[6px] transition-colors hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2" aria-label="Notifications">
                <Bell className="size-4" />
                <span className="absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full bg-vez-navy text-[8px] text-white">
                  3
                </span>
              </button>
            )}
            <button
              className="flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/40 text-vez-ink backdrop-blur-[6px] transition-colors hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2 cursor-pointer"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu - responsive drawer with safe area and 44px touch targets */}
        <div
          className={cn(
            "xl:hidden overflow-hidden transition-all duration-300",
            mobileOpen ? "max-h-[85dvh]" : "max-h-0"
          )}
        >
          <nav className="flex max-h-[75dvh] flex-col gap-1 overflow-y-auto overscroll-contain border-t border-vez-line bg-white px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6">
            <p className="px-4 py-1 text-xs font-medium uppercase tracking-wider text-vez-mute">{t("nav.product")}</p>
            {productLinks.map((link) => {
              const href = isHome ? link.id : `/${link.id}`
              return (
                <Link
                  key={link.tKey}
                  href={href}
                  onClick={(e) => handleNavClick(e, href, true)}
                  className="flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base text-vez-ink transition-colors hover:bg-vez-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 cursor-pointer"
                >
                  {t(link.tKey)}
                </Link>
              )
            })}

            <div className="my-2 h-px bg-vez-line" />

            {resourceLinks.map((link) => (
              <Link
                key={link.tKey}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20",
                  isActive(link.href, false) ? "bg-vez-navy text-white" : "text-vez-ink hover:bg-vez-surface"
                )}
              >
                {t(link.tKey)}
              </Link>
            ))}

            <div className="my-2 h-px bg-vez-line" />

            {standaloneLinks.map((link) => {
              const href = link.anchor ? (isHome ? link.id! : `/${link.id}`) : link.href!
              return (
                <Link
                  key={link.tKey}
                  href={href}
                  onClick={(e) => handleNavClick(e, href, link.anchor)}
                  className={cn(
                    "flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20",
                    isActive(href, link.anchor) ? "bg-vez-navy text-white" : "text-vez-ink hover:bg-vez-surface"
                  )}
                >
                  {t(link.tKey)}
                </Link>
              )
            })}

            <Link
              href="/contact"
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20",
                pathname === "/contact" ? "bg-vez-navy text-white" : "text-vez-ink hover:bg-vez-surface"
              )}
            >
              {t("nav.contact")}
            </Link>

            <div className="my-2 h-px bg-vez-line" />

            <button
              onClick={() => setLanguage(language === "en" ? "ne" : "en")}
              className="flex min-h-[44px] items-center gap-2 rounded-[12px] px-4 py-3 text-base text-vez-ink hover:bg-vez-surface cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20"
            >
              <Globe className="size-4" />
              {language === "en" ? "English" : "नेपाली"}
            </button>

            <div className="my-2 h-px bg-vez-line" />

            {user ? (
              <>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-vez-sky">
                    <span className="text-sm text-vez-navy">{user.username[0].toUpperCase()}</span>
                  </div>
                  <div>
                    <p className="text-base text-vez-ink">{user.username}</p>
                    <p className="text-sm capitalize text-vez-mute">{user.role}</p>
                  </div>
                </div>

                <Link
                  href="/dashboard"
                  onClick={() => setMobileOpen(false)}
                  className="flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base text-vez-ink hover:bg-vez-surface cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20"
                >
                  {t("nav.dashboard")}
                </Link>
                {user.role === "admin" && (
                  <Link
                    href="/admin"
                    onClick={() => setMobileOpen(false)}
                    className="flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-base text-vez-ink hover:bg-vez-surface cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20"
                  >
                    {t("nav.adminPanel")}
                  </Link>
                )}
                <button
                  onClick={() => {
                    logout()
                    setMobileOpen(false)
                  }}
                  className="flex min-h-[44px] items-center rounded-[12px] px-4 py-3 text-left text-base text-red-600 hover:bg-red-50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                >
                  {t("nav.signout")}
                </button>
              </>
            ) : (
              <Link
                href="/login"
                onClick={() => setMobileOpen(false)}
                className="mt-2 flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-vez-navy px-6 py-3 text-base text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2"
              >
                {t("nav.signin")}
                <ArrowUpRight className="size-4" />
              </Link>
            )}
          </nav>
        </div>
      </header>

      {/* Spacer - only off home; matches header h-16 / sm:h-20 + safe inset. Hero handles its own padding. */}
      {!isHome && <div className="h-[calc(4rem+env(safe-area-inset-top))] sm:h-[calc(5rem+env(safe-area-inset-top))]" aria-hidden="true" />}
    </>
  )
}
