import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { SetupClient } from "./SetupClient";
import "../../connect.css";
import "./setup.css";

export const metadata: Metadata = {
  title: "Finish wallet setup · merrymen",
  description: "Confirm your trading limits and sign, then return to your assistant.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^prp_[0-9a-f]{32}$/.test(id)) notFound();
  return <Providers locale={DEFAULT_LOCALE}><SetupClient id={id} /></Providers>;
}
