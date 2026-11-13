import { Brand } from "../../../components/layout";
import { Button, Icon } from "../../../components/ui";
import type { PublicPage } from "../../../types";

const landingFeatures: [string, string][] = [
  ["Smart budgets", "wallet"],
  ["Guest lists", "users"],
  ["Vendor hub", "store"],
  ["Shared tasks", "check"],
  ["Event timelines", "clock"],
];

export function Landing({ setPage, enterApp }: { setPage: (p: PublicPage) => void; enterApp: () => void }) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Brand />
        <nav>
          <a href="#features">Features</a>
          <a href="#templates">Templates</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="landing-actions">
          <Button variant="ghost" onClick={() => setPage("login")}>
            Log in
          </Button>
          <Button onClick={() => setPage("signup")}>Plan your event</Button>
        </div>
      </header>
      <main className="hero">
        <div className="hero-copy">
          <div className="hero-pill">
            <Icon name="spark" size={15} /> Planning made lighter
          </div>
          <h1>
            Big moments.
            <br />
            <span>Beautifully planned.</span>
          </h1>
          <p>
            EventWise brings your budget, guests, vendors, and to-dos together—so you can spend less
            time juggling and more time celebrating.
          </p>
          <div className="hero-actions">
            <Button onClick={enterApp}>
              Explore the demo <Icon name="arrow" size={17} />
            </Button>
            <Button variant="secondary" onClick={() => setPage("signup")}>
              Start planning free
            </Button>
          </div>
          <div className="hero-proof">
            <div className="avatars">
              <span>ML</span>
              <span>AK</span>
              <span>JO</span>
              <span>+2k</span>
            </div>
            <div>
              <b>Loved by happy planners</b>
              <small>Simple, thoughtful, stress-free.</small>
            </div>
          </div>
        </div>
        <div className="hero-visual">
          <div className="confetti c1" />
          <div className="confetti c2" />
          <div className="confetti c3" />
          <div className="mock-window">
            <div className="mock-bar">
              <i />
              <i />
              <i />
              <span>maya-and-eli.eventwise.co</span>
            </div>
            <div className="mock-content">
              <div className="mock-side">
                <div className="mock-logo">E</div>
                {[1, 2, 3, 4, 5].map((x) => (
                  <div className={`mock-nav ${x === 1 ? "active" : ""}`} key={x} />
                ))}
              </div>
              <div className="mock-main">
                <div className="mock-welcome">
                  <small>SEPTEMBER 20, 2025</small>
                  <h3>Maya & Eli’s Wedding</h3>
                  <div className="mock-progress">
                    <span style={{ width: "68%" }} />
                  </div>
                </div>
                <div className="mock-grid">
                  <div>
                    <small>YOUR BUDGET</small>
                    <strong>$31,240</strong>
                    <div className="donut" />
                  </div>
                  <div>
                    <small>GUESTS</small>
                    <strong>
                      86 <em>of 120</em>
                    </strong>
                    <div className="mini-guests">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
                <div className="mock-task">
                  <span>✓</span>
                  <div>
                    <b>Finalize dinner menu</b>
                    <small>Due Friday · Assigned to Maya</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="float-card float-budget">
            <div className="float-icon">
              <Icon name="wallet" />
            </div>
            <div>
              <small>Under budget</small>
              <b>$3,760 remaining</b>
            </div>
          </div>
          <div className="float-card float-rsvp">
            <div className="float-icon coral">
              <Icon name="users" />
            </div>
            <div>
              <small>New RSVP</small>
              <b>Sofia is attending</b>
            </div>
          </div>
        </div>
      </main>
      <section className="landing-bottom" id="features">
        <span>Everything in one happy place</span>
        {landingFeatures.map(([label, icon]) => (
          <div key={label}>
            <Icon name={icon} size={18} />
            {label}
          </div>
        ))}
      </section>
    </div>
  );
}
