export interface FlowbridgeOptions {
  src?: string;
  content?: string;
  sourcePath?: string;
  annotationsSrc?: string;
  height?: number;
  theme?: string;
  tooltipTrigger?: 'hover' | 'click';
}

export interface AnnotationLink {
  label: string;
  href: string; // "ext:path/to/file.mmd" ou URL externa
}

export interface NodeAnnotation {
  title?: string;
  description?: string;
  owner?: string;
  sla?: string;
  since?: string;
  alert?: string;
  tags?: string[];
  links?: AnnotationLink[];
}

export type AnnotationsMap = Record<string, NodeAnnotation>;

export interface DiagramData {
  path: string;
  title: string;
  content: string;
  annotations: AnnotationsMap;
  labels: Map<string, string>;
  links: Map<string, string>;
}
