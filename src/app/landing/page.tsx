import { LandingNavbar } from "./components/navbar"
import { HeroSection } from "./components/hero-section"
import { ProblemSection } from "./components/problem-section"
import { ProductDemoSection } from "./components/product-demo-section"
import { FeaturesSection } from "./components/features-section"
import { GallerySection } from "./components/gallery-section"
import { HowItWorksSection } from "./components/how-it-works-section"
import { PricingSection } from "./components/pricing-section"
import { FaqSection } from "./components/faq-section"
import { CTASection } from "./components/cta-section"
import { LandingFooter } from "./components/footer"

export default function LandingPage() {
  return (
    <div className="light-surface min-h-screen bg-white text-[#102342]">
      <LandingNavbar />
      <main>
        <HeroSection />
        <ProblemSection />
        <ProductDemoSection />
        <FeaturesSection />
        <GallerySection />
        <HowItWorksSection />
        <PricingSection />
        <FaqSection />
        <CTASection />
      </main>
      <LandingFooter />
    </div>
  )
}
