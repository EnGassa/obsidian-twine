import { Platform } from "obsidian";

export const isMobile = (): boolean => Platform.isMobile;
export const isDesktop = (): boolean => !Platform.isMobile;
