'use client';

import { useState, useEffect, useRef } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { BottomNav } from './bottom-nav';
import { OrgContext } from '@/hooks/use-org';
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet';

interface DashboardShellProps {
  orgs: string[];
  children: React.ReactNode;
}

export function DashboardShell({ orgs, children }: DashboardShellProps) {
  // Initialize deterministically so the first client render matches the server
  // (which has no window/localStorage). Reading the URL/localStorage in the
  // useState initializer caused a hydration mismatch: the server rendered
  // org='all' while the client's first render read a saved org from
  // localStorage, producing different nav hrefs.
  const [currentOrg, setCurrentOrg] = useState<string>('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // After mount, resolve the org: URL is authoritative (?org=), else localStorage.
  useEffect(() => {
    const urlOrg = new URLSearchParams(window.location.search).get('org');
    if (urlOrg && (urlOrg === 'all' || orgs.includes(urlOrg))) {
      setCurrentOrg(urlOrg);
      return;
    }
    const saved = localStorage.getItem('cortextos-org');
    if (saved && (saved === 'all' || orgs.includes(saved))) {
      setCurrentOrg(saved);
    }
    // Run once on mount; orgs is stable for the shell's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist org selection to localStorage, but skip the initial mount write so
  // we don't clobber a saved value before the resolver effect above reads it.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current) {
      didInit.current = true;
      return;
    }
    localStorage.setItem('cortextos-org', currentOrg);
  }, [currentOrg]);

  return (
    <OrgContext.Provider value={{ currentOrg, setCurrentOrg, orgs }}>
      <div className="flex h-screen">
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar onNavigate={() => {}} />
        </div>

        {/* Mobile sidebar sheet */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-60 p-0" showCloseButton={false}>
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar
            orgs={orgs}
            currentOrg={currentOrg}
            onOrgChange={setCurrentOrg}
            onMenuClick={() => setSidebarOpen(true)}
          />
          <main className="flex-1 overflow-auto p-4 pb-20 md:pb-5 md:p-5 lg:p-6 bg-background">
            {children}
          </main>

          {/* Mobile bottom navigation */}
          <BottomNav />
        </div>
      </div>
    </OrgContext.Provider>
  );
}
