import type { SVGAttributes } from "react";

interface LogoProps extends SVGAttributes<SVGSVGElement> {
  size?: number;
  variant?: "light" | "dark";
}

export function Logo({ size = 24, className = "", variant = "light", ...rest }: LogoProps) {
  const barColor = variant === "dark" ? "#FFFFFF" : "#151515";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <rect x="111" y="250" width="70" height="110" rx="20" fill={barColor} />
      <rect x="221" y="190" width="70" height="170" rx="20" fill={barColor} />
      <rect x="331" y="130" width="70" height="230" rx="20" fill={barColor} />
      <circle cx="146" cy="192" r="32" fill="#E4A034" />
      <circle cx="256" cy="132" r="32" fill="#E4A034" />
      <circle cx="366" cy="72" r="32" fill="#E4A034" />
    </svg>
  );
}
