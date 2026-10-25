"""Black-Scholes-Merton pricing, implied volatility and greeks (incl. vanna, charm).

All functions take: S spot, K strike, T years, r rate, q dividend yield, sigma vol, is_call bool.
Units: gamma per 1 point, vanna = d(delta)/d(sigma) per 1.00 vol, charm = d(delta)/dt per year (sign:
change of delta as time passes, i.e. -dDelta/dT).
"""
from __future__ import annotations
import math

SQ2 = math.sqrt(2.0)
SQ2PI = math.sqrt(2.0 * math.pi)


def ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / SQ2))


def npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQ2PI


def _d1d2(S, K, T, r, q, sigma):
    vt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt
    return d1, d1 - vt


def price(S, K, T, r, q, sigma, is_call):
    if T <= 0 or sigma <= 0:
        return max(0.0, (S - K) if is_call else (K - S))
    d1, d2 = _d1d2(S, K, T, r, q, sigma)
    if is_call:
        return S * math.exp(-q * T) * ncdf(d1) - K * math.exp(-r * T) * ncdf(d2)
    return K * math.exp(-r * T) * ncdf(-d2) - S * math.exp(-q * T) * ncdf(-d1)


def implied_vol(px, S, K, T, r, q, is_call, lo=0.005, hi=5.0, tol=1e-6, it=100):
    """Bisection + Newton hybrid; returns None if price is outside no-arbitrage bounds."""
    if T <= 0 or px is None or px <= 0:
        return None
    intrinsic = max(0.0, (S * math.exp(-q * T) - K * math.exp(-r * T)) if is_call else (K * math.exp(-r * T) - S * math.exp(-q * T)))
    upper = S * math.exp(-q * T) if is_call else K * math.exp(-r * T)
    if px < intrinsic - 1e-9 or px >= upper:
        return None
    a, b = lo, hi
    if price(S, K, T, r, q, a, is_call) > px:
        return a
    if price(S, K, T, r, q, b, is_call) < px:
        return None
    s = 0.3
    for _ in range(it):
        p = price(S, K, T, r, q, s, is_call)
        diff = p - px
        if abs(diff) < tol:
            return s
        if diff > 0:
            b = s
        else:
            a = s
        d1, _ = _d1d2(S, K, T, r, q, s)
        vega = S * math.exp(-q * T) * npdf(d1) * math.sqrt(T)
        s_new = s - diff / vega if vega > 1e-10 else (a + b) / 2
        s = s_new if a < s_new < b else (a + b) / 2
    return s


def greeks(S, K, T, r, q, sigma, is_call):
    """Returns dict(delta, gamma, vega, vanna, charm). Expiring/degenerate contracts → delta step, zeros."""
    if T <= 0 or sigma <= 0:
        itm = (S > K) if is_call else (S < K)
        return dict(delta=(1.0 if itm else 0.0) * (1 if is_call else -1), gamma=0.0, vega=0.0, vanna=0.0, charm=0.0)
    sqT = math.sqrt(T)
    d1, d2 = _d1d2(S, K, T, r, q, sigma)
    eq = math.exp(-q * T)
    pdf = npdf(d1)
    delta = eq * ncdf(d1) if is_call else -eq * ncdf(-d1)
    gamma = eq * pdf / (S * sigma * sqT)
    vega = S * eq * pdf * sqT
    vanna = -eq * pdf * d2 / sigma
    # charm = -dDelta/dT (Haug); call/put differ only in the q term
    common = eq * pdf * (2 * (r - q) * T - d2 * sigma * sqT) / (2 * T * sigma * sqT)
    charm = (q * eq * ncdf(d1) - common) if is_call else (-q * eq * ncdf(-d1) - common)
    return dict(delta=delta, gamma=gamma, vega=vega, vanna=vanna, charm=charm)
