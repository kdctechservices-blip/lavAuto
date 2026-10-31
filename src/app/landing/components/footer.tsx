import { Link } from "react-router-dom"
import { BrandMark } from "@/components/brand"

const footerLinks = [
  { label: "Les enjeux", href: "#enjeux" },
  { label: "Démo produit", href: "#demo" },
  { label: "Fonctionnalités", href: "#fonctionnalites" },
  { label: "Questions fréquentes", href: "#faq" },
]

export function LandingFooter() {
  return (
    <footer className="bg-[#071a36] text-white">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 border-b border-white/10 pb-8 md:flex-row md:items-center md:justify-between">
          <div className="max-w-md">
            <Link to="/landing" className="inline-flex items-center gap-3">
              <BrandMark height={36} tone="dark" />
              <span className="text-lg font-extrabold tracking-[-0.04em]">WashPilot <span className="text-sky-300">CI</span></span>
            </Link>
            <p className="mt-4 text-sm leading-6 text-blue-100/65">
              La gestion de votre station, enfin plus claire. Des repères concrets à partir des opérations que vous enregistrez.
            </p>
          </div>
          <nav aria-label="Liens de pied de page" className="flex flex-wrap gap-x-5 gap-y-3 text-xs font-semibold text-blue-100/75 sm:text-sm">
            {footerLinks.map((item) => (
              <a key={item.href} href={item.href} className="transition-colors hover:text-white motion-reduce:transition-none">
                {item.label}
              </a>
            ))}
            <Link to="/auth/sign-in" className="transition-colors hover:text-white motion-reduce:transition-none">Connexion</Link>
          </nav>
        </div>
        <div className="flex flex-col gap-2 pt-5 text-[10px] leading-5 text-blue-100/45 sm:flex-row sm:items-center sm:justify-between sm:text-xs">
          <span>© {new Date().getFullYear()} WashPilot CI. Tous droits réservés.</span>
          <span>Les chiffres de démonstration sont fictifs. Aucun niveau de gains n’est garanti.</span>
        </div>
      </div>
    </footer>
  )
}
