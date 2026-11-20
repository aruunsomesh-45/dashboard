import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_BACKEND = "https://motion-islamic-starting-window.trycloudflare.com";

async function proxyRequest(req: NextRequest, { params }: { params: { path?: string[] } }) {
  let targetHost = process.env.BACKEND_URL || DEFAULT_BACKEND;
  if (!targetHost || targetHost.includes("brooks-pharmaceuticals") || (process.env.VERCEL === "1" && targetHost.includes("127.0.0.1"))) {
    targetHost = DEFAULT_BACKEND;
  }
  const cleanTargetHost = targetHost.replace(/\/+$/, "");

  const pathParts = params?.path || [];
  const joinedPath = pathParts.join("/");
  const hasTrailingSlash = req.nextUrl.pathname.endsWith("/");
  const pathWithSlash = joinedPath ? (hasTrailingSlash ? `${joinedPath}/` : joinedPath) : (hasTrailingSlash ? "/" : "");
  const search = req.nextUrl.search || "";
  const targetUrl = `${cleanTargetHost}/api/${pathWithSlash}${search}`;
  const fallbackUrl = `${DEFAULT_BACKEND}/api/${pathWithSlash}${search}`;

  const headers = new Headers();
  req.headers.forEach((val, key) => {
    const lk = key.toLowerCase();
    if (lk !== "host" && lk !== "connection" && lk !== "content-length") {
      headers.set(key, val);
    }
  });

  const parsedHost = new URL(cleanTargetHost).host;
  headers.set("host", parsedHost);
  headers.set("x-forwarded-host", req.headers.get("host") || "125east-dashboard.vercel.app");
  headers.set("x-forwarded-proto", "https");

  const method = req.method;
  let body: BodyInit | undefined = undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  let backendRes: Response | null = null;
  try {
    backendRes = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });

    if (backendRes.status >= 502 && cleanTargetHost !== DEFAULT_BACKEND) {
      const fallbackHeaders = new Headers(headers);
      fallbackHeaders.set("host", new URL(DEFAULT_BACKEND).host);
      backendRes = await fetch(fallbackUrl, {
        method,
        headers: fallbackHeaders,
        body,
        redirect: "manual",
        cache: "no-store",
      });
    }
  } catch (err: any) {
    if (cleanTargetHost !== DEFAULT_BACKEND) {
      try {
        const fallbackHeaders = new Headers(headers);
        fallbackHeaders.set("host", new URL(DEFAULT_BACKEND).host);
        backendRes = await fetch(fallbackUrl, {
          method,
          headers: fallbackHeaders,
          body,
          redirect: "manual",
          cache: "no-store",
        });
      } catch (fallbackErr: any) {
        return NextResponse.json(
          {
            error: "Backend service unreachable.",
            details: fallbackErr?.message || String(fallbackErr),
          },
          { status: 502 }
        );
      }
    } else {
      return NextResponse.json(
        {
          error: "Backend service unreachable.",
          details: err?.message || String(err),
        },
        { status: 502 }
      );
    }
  }

  if (!backendRes || backendRes.status >= 502) {
    return NextResponse.json(
      {
        error: "Backend service unreachable via proxy tunnel.",
        details: "The backend server or tunnel is currently unreachable.",
        status: backendRes?.status || 502,
      },
      { status: 502 }
    );
  }

  const resHeaders = new Headers();
  backendRes.headers.forEach((val, key) => {
    const lk = key.toLowerCase();
    if (lk === "set-cookie") {
      resHeaders.append(key, val);
    } else if (lk !== "content-encoding" && lk !== "transfer-encoding" && lk !== "content-length") {
      resHeaders.set(key, val);
    }
  });

  const resBuffer = await backendRes.arrayBuffer();
  return new NextResponse(resBuffer, {
    status: backendRes.status,
    statusText: backendRes.statusText,
    headers: resHeaders,
  });
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const HEAD = proxyRequest;
export const OPTIONS = proxyRequest;
