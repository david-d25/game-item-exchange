import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export const BellIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3l1-1Z" />
    <path d="M6.5 14a1.6 1.6 0 0 0 3 0" />
  </Icon>
)

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)

export const ArrowUpRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 11l6-6M6 5h5v5" />
  </Icon>
)

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75v3.75M8 11h.01" />
  </Icon>
)

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
)
