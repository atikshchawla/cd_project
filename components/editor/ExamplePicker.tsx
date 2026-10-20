'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EXAMPLES } from '@/content/examples';
import { useWorkspaceStore } from '@/lib/store';

export function ExamplePicker() {
  const exampleId = useWorkspaceStore((state) => state.exampleId);
  const loadExample = useWorkspaceStore((state) => state.loadExample);
  const resetExample = useWorkspaceStore((state) => state.resetExample);
  const learningExamples = EXAMPLES.filter((example) => example.category === 'learn');
  const errorExamples = EXAMPLES.filter((example) => example.category === 'error');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={exampleId ?? ''}
        onValueChange={(value) => {
          if (value !== '') loadExample(value);
        }}
      >
        <SelectTrigger className="w-full min-w-[12rem] sm:w-[15rem]" aria-label="Choose an example">
          <SelectValue placeholder="Choose an example…" />
        </SelectTrigger>
        <SelectContent>
          {learningExamples.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Learn</SelectLabel>
              {learningExamples.map((example) => (
                <SelectItem key={example.id} value={example.id}>
                  {example.title}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {errorExamples.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Errors</SelectLabel>
              {errorExamples.map((example) => (
                <SelectItem key={example.id} value={example.id}>
                  {example.title}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={resetExample}
        disabled={exampleId === null}
        title="Restore the selected example's original code"
      >
        <RotateCcw aria-hidden="true" />
        Reset to example
      </Button>
    </div>
  );
}
