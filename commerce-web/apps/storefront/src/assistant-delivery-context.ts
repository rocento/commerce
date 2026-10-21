import { createContext, useContext } from "react";

export const AssistantDeliveryContext = createContext<{
  requestLocation: () => void;
  requestNewAddress: () => void;
  subscribeToUpdates: (listener: (message: string, locationId?: string) => void) => () => void;
} | null>(null);

export const useAssistantDelivery = () => useContext(AssistantDeliveryContext);
