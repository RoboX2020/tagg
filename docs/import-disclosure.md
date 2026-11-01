# Required owner disclosure copy for profile imports

The worker routes hard-gate on these disclosure tokens (`/api/enrich/x`, `/api/enrich/github`,
`/api/enrich/linkedin-auto`): the request is rejected unless the client sends the exact token,
which the UI must only send after rendering the matching notice and the owner taps Agree.
This file is the copy the UI MUST render, verbatim, before that tap. Do not soften or trim it.

## x-auto-v1 (public X profile)
"Tagg will fetch the public X profile at the link you provide and add the name, handle, bio
and location shown there to your own Tagg card. People you share your card with - and your
assistant if you enable it - will see this under 'imported', marked with the source link and
the date it was fetched. Tagg does not verify it. Your private card details stay private.
You can remove the import at any time."

## github-auto-v1 (public GitHub profile)
"Tagg will fetch the public GitHub profile at the link you provide and add the bio, company
and location shown there to your own Tagg card. People you share your card with - and your
assistant if you enable it - will see this under 'imported', marked with the source link and
the date it was fetched. Tagg does not verify it. Your private card details stay private.
You can remove the import at any time."

## linkedin-auto-v1 / linkedin-auto-v2 (LinkedIn)
"Tagg will read the LinkedIn profile text you paste (or the public profile you link) and add
the headline, roles, companies, schools and location to your own Tagg card. People you share
your card with - and your assistant if you enable it - will see this under 'imported', marked
with where it came from and when. Tagg does not verify it. Pasted text is marked as entered
by you, not fetched. You can remove it at any time."

## Visibility rule (applies to all three)
Imported material is never public by default. It is attached to the owner's card and follows
the card's existing sharing: only people the owner shares the card with see it, and MCP/agent
access only under an owner-created token. An import must never change who can see the card.
