import {
  ArrowUpRight,
  Car,
  Coffee,
  Dumbbell,
  Flame,
  Gamepad2,
  Languages,
  MapPin,
  MessageCircle,
  Mountain,
  PawPrint,
  Phone,
  ShowerHead,
  Sparkles,
  Tent,
  Thermometer,
  Trees,
  Tv,
  Wifi,
  Wind,
} from "lucide-react";

/** Icons referenced by name from the data module (src/lib/site.ts). */
const REGISTRY = {
  ArrowUpRight,
  Car,
  Coffee,
  Dumbbell,
  Flame,
  Gamepad2,
  Languages,
  MapPin,
  MessageCircle,
  Mountain,
  PawPrint,
  Phone,
  ShowerHead,
  Sparkles,
  Tent,
  Thermometer,
  Trees,
  Tv,
  Wifi,
  Wind,
};

export type IconName = keyof typeof REGISTRY;

export function Icon({
  name,
  className,
  size = 20,
  strokeWidth = 1.6,
}: {
  name: string;
  className?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const Cmp = REGISTRY[name as IconName] ?? Sparkles;
  return <Cmp className={className} size={size} strokeWidth={strokeWidth} aria-hidden />;
}
