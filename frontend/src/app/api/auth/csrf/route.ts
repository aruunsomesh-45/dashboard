import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const token = "serverless-csrf-" + Math.random().toString(36).substring(2);
  const res = NextResponse.json({ csrfToken: token });
  res.cookies.set("csrftoken", token, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
