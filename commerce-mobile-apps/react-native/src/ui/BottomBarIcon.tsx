import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

type IconName = ComponentProps<typeof Ionicons>['name'];
const icons = {
  home: ['home-outline', 'home'],
  catalog: ['grid-outline', 'grid'],
  deals: ['pricetag-outline', 'pricetag'],
  account: ['person-circle-outline', 'person-circle'],
  bag: ['cart-outline', 'cart'],
  settings: ['settings-outline', 'settings'],
} as const satisfies Record<string, readonly [IconName, IconName]>;

export function BottomBarIcon({ name, selected, color }: {
  name: keyof typeof icons;
  selected: boolean;
  color: string;
}) {
  return <Ionicons name={icons[name][selected ? 1 : 0]} size={26} color={color}
    accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
