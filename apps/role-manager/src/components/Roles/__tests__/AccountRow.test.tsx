import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { AccountRow } from '../AccountRow';

vi.mock('@openzeppelin/ui-components', () => ({
  AddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

describe('AccountRow', () => {
  it('shows the transfer ownership button for the current owner', () => {
    render(
      <AccountRow
        address="0xowner"
        isCurrentUser={true}
        isOwnerRole={true}
        onTransferOwnership={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /transfer ownership/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/only the current owner can transfer ownership/i)
    ).not.toBeInTheDocument();
  });

  it('explains why ownership transfer is unavailable for a non-owner viewer', () => {
    render(
      <AccountRow
        address="0xowner"
        isCurrentUser={false}
        isOwnerRole={true}
        onTransferOwnership={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: /transfer ownership/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only the current owner can transfer ownership/i)).toBeInTheDocument();
  });
});
